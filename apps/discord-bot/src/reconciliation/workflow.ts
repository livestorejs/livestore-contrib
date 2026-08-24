import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import type { DiscordSnowflake, ThreadActionRecord } from "../journal/model.ts"
import type {
  JournalUnavailableError,
  JournalWriteError,
  ThreadActionJournalService,
} from "../journal/service.ts"
import {
  InvalidReconciliationRequest,
  type ReconciliationDisposition,
  type ReconciliationReceipt,
  type ReconciliationRequest,
  type ReconciliationResult,
} from "./model.ts"
import type { ThreadObservationPort } from "./port.ts"

const defaultAllLimit = 25
export const maximumReconciliationLimit = 100

export type ReconciliationError = InvalidReconciliationRequest | JournalWriteError

/**
 * Reconciles only ambiguous journal entries by observing Discord. The workflow
 * deliberately has no create port, so no recovery branch can replay a write.
 */
export const makeThreadReconciliationWorkflow = (
  journal: ThreadActionJournalService,
  observer: ThreadObservationPort,
) => (request: ReconciliationRequest): Effect.Effect<ReconciliationResult, ReconciliationError> =>
  Effect.gen(function* () {
    const validated = yield* Effect.try({
      try: () => validateRequest(request),
      catch: cause => cause instanceof InvalidReconciliationRequest
        ? cause
        : new InvalidReconciliationRequest({ message: "reconciliation request is invalid" }),
    })
    const selected = yield* selectRecords(journal, validated)
    const receipts = yield* Effect.forEach(
      selected.records,
      record => reconcileRecord(journal, observer, validated, record),
      { concurrency: 1 },
    )
    return { receipts, truncated: selected.truncated }
  }).pipe(Effect.withSpan("discord.reconciliation.run"))

const selectRecords = (
  journal: ThreadActionJournalService,
  request: ReconciliationRequest,
): Effect.Effect<
  { readonly records: ReadonlyArray<ThreadActionRecord | MissingRecord>; readonly truncated: boolean },
  JournalUnavailableError
> => {
  if (request.selection._tag === "One") {
    const sourceMessageId = request.selection.sourceMessageId
    return journal.get(sourceMessageId).pipe(
      Effect.map(record => ({
        records: [record ?? { missing: true as const, sourceMessageId }],
        truncated: false,
      })),
    )
  }
  const limit = request.selection.limit ?? defaultAllLimit
  return journal.listRecoverable.pipe(Effect.map(records => {
    const eligible = records.filter(record =>
      (record.state === "pending" || record.state === "creating" || record.state === "unknown_external") &&
      (request.selection._tag === "All" &&
        (request.selection.state === undefined || record.state === request.selection.state)),
    )
    return { records: eligible.slice(0, limit), truncated: eligible.length > limit }
  }))
}

interface MissingRecord {
  readonly missing: true
  readonly sourceMessageId: DiscordSnowflake
}

const reconcileRecord = (
  journal: ThreadActionJournalService,
  observer: ThreadObservationPort,
  request: ReconciliationRequest,
  record: ThreadActionRecord | MissingRecord,
): Effect.Effect<ReconciliationReceipt, JournalWriteError> => {
  if ("missing" in record) {
    return Effect.succeed(receipt(record.sourceMessageId, "not_found", "not_found", "not_found", false))
  }
  if (record.state !== "creating" && record.state !== "unknown_external") {
    if (record.state === "pending") {
      if (request.pendingPolicy !== "close-interrupted" && request.now < record.reconcileBy) {
        return Effect.succeed(receipt(record.sourceMessageId, "pending", "pending", "not_eligible", false))
      }
      if (request.mode._tag === "Plan") {
        return Effect.succeed(receipt(
          record.sourceMessageId,
          "pending",
          "manual_review",
          "would_close_interrupted_pending",
          false,
        ))
      }
      return journal.markManualReview({
        sourceMessageId: record.sourceMessageId,
        claimToken: record.claimToken,
        now: request.now,
        outcomeCode: "interrupted_before_mutation",
      }).pipe(Effect.map(updated => receipt(
        record.sourceMessageId,
        "pending",
        updated.state,
        "interrupted_pending_closed",
        true,
      )))
    }
    return Effect.succeed(receipt(record.sourceMessageId, record.state, record.state, "not_eligible", false))
  }

  return observer.observeSourceThread({
    sourceMessageId: record.sourceMessageId,
    channelId: record.channelId,
  }).pipe(
    Effect.match({
      onFailure: () => ({ _tag: "Unrun" as const, reason: "discord_read_unavailable" as const }),
      onSuccess: observation => observation,
    }),
    Effect.flatMap(observation => {
      if (observation._tag === "Unrun") {
        if (request.now >= record.reconcileBy) {
          if (request.mode._tag === "Plan") {
            return Effect.succeed(receipt(
              record.sourceMessageId,
              record.state,
              "manual_review",
              "would_mark_manual_review",
              false,
              undefined,
              observation.reason,
            ))
          }
          return journal.markManualReview({
            sourceMessageId: record.sourceMessageId,
            claimToken: record.claimToken,
            now: request.now,
            outcomeCode: "ambiguous_mutation_unresolved",
          }).pipe(Effect.map(updated => receipt(
            record.sourceMessageId,
            record.state,
            updated.state,
            "manual_review",
            true,
            undefined,
            observation.reason,
          )))
        }
        return Effect.succeed(receipt(
          record.sourceMessageId,
          record.state,
          record.state,
          "unrun",
          false,
          undefined,
          observation.reason,
        ))
      }
      if (observation._tag === "ExactSourceThread") {
        if (request.mode._tag === "Plan") {
          return Effect.succeed(receipt(
            record.sourceMessageId,
            record.state,
            "created",
            "would_adopt",
            false,
            observation.threadId,
          ))
        }
        return journal.markCreated({
          sourceMessageId: record.sourceMessageId,
          claimToken: record.claimToken,
          now: request.now,
          threadId: observation.threadId,
          resolution: "existing",
        }).pipe(Effect.map(updated => receipt(
          record.sourceMessageId,
          record.state,
          updated.state,
          "adopted",
          true,
          observation.threadId,
        )))
      }

      const deadlineElapsed = request.now >= record.reconcileBy
      const targetDisposition: ReconciliationDisposition = deadlineElapsed
        ? request.mode._tag === "Plan" ? "would_mark_manual_review" : "manual_review"
        : request.mode._tag === "Plan" ? "would_record_absence" : "absence_recorded"
      const targetState = deadlineElapsed ? "manual_review" as const : "unknown_external" as const
      if (request.mode._tag === "Plan") {
        return Effect.succeed(receipt(
          record.sourceMessageId,
          record.state,
          targetState,
          targetDisposition,
          false,
        ))
      }
      // A maximum observation bound makes the journal's deadline, not an
      // arbitrary retry count, the sole condition for manual review here.
      return journal.observeAmbiguity({
        sourceMessageId: record.sourceMessageId,
        claimToken: record.claimToken,
        now: request.now,
        minimumObservations: Number.MAX_SAFE_INTEGER,
      }).pipe(Effect.map(updated => receipt(
        record.sourceMessageId,
        record.state,
        updated.state,
        targetDisposition,
        true,
      )))
    }),
  )
}

const validateRequest = (request: ReconciliationRequest): ReconciliationRequest => {
  if (!Number.isSafeInteger(request.now) || request.now < 0) {
    throw new InvalidReconciliationRequest({ message: "now must be a non-negative safe integer" })
  }
  if (request.mode._tag === "Apply" && request.mode.reason.trim().length < 3) {
    throw new InvalidReconciliationRequest({ message: "apply requires a non-empty operator reason" })
  }
  if (request.selection._tag === "All" && request.selection.limit !== undefined &&
    (!Number.isSafeInteger(request.selection.limit) || request.selection.limit < 1 ||
      request.selection.limit > maximumReconciliationLimit)) {
    throw new InvalidReconciliationRequest({
      message: `all limit must be between 1 and ${maximumReconciliationLimit}`,
    })
  }
  return request
}

const receipt = (
  sourceMessageId: DiscordSnowflake,
  beforeState: ReconciliationReceipt["beforeState"],
  afterState: ReconciliationReceipt["afterState"],
  disposition: ReconciliationDisposition,
  mutated: boolean,
  threadId?: DiscordSnowflake,
  unrunReason?: ReconciliationReceipt["unrunReason"],
): ReconciliationReceipt => {
  const material = [
    sourceMessageId,
    beforeState,
    afterState,
    disposition,
    mutated ? "1" : "0",
    threadId ?? "",
    unrunReason ?? "",
  ].join("\n")
  const receiptId = `reconcile-${createHash("sha256").update(material).digest("hex").slice(0, 20)}`
  return { receiptId, sourceMessageId, beforeState, afterState, disposition, mutated, threadId, unrunReason }
}
