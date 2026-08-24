import { randomUUID } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { decodeDiscordSnowflake, type ThreadActionRecord } from "../journal/model.ts"
import type { ThreadActionJournalService } from "../journal/service.ts"
import { makeSqliteThreadActionJournal } from "../journal/sqlite.ts"
import type { ThreadObservation, ReconciliationMode } from "./model.ts"
import type { ThreadObservationPort } from "./port.ts"
import { makeThreadReconciliationWorkflow } from "./workflow.ts"

const channelId = decodeDiscordSnowflake("100000000000000900")
const firstId = decodeDiscordSnowflake("100000000000000901")
const secondId = decodeDiscordSnowflake("100000000000000902")
const firstThreadId = decodeDiscordSnowflake("100000000000000911")

describe("thread reconciliation workflow", () => {
  it.effect("plans an exact adoption with deterministic receipts and zero journal writes", () =>
    withJournal(journal => Effect.gen(function* () {
      const record = yield* ambiguous(journal, firstId, 1_000, 2_000)
      const run = makeThreadReconciliationWorkflow(journal, observer({
        _tag: "ExactSourceThread",
        threadId: firstThreadId,
      }))
      const request = one(firstId, { _tag: "Plan" }, 1_500)
      const first = yield* run(request)
      const repeated = yield* run(request)

      expect(first).toEqual(repeated)
      expect(first.receipts[0]).toMatchObject({
        disposition: "would_adopt",
        beforeState: "creating",
        afterState: "created",
        mutated: false,
        threadId: firstThreadId,
      })
      expect(yield* journal.get(firstId)).toEqual(record)
    })).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("adopts only an exactly source-anchored thread without replaying create", () =>
    withJournal(journal => Effect.gen(function* () {
      yield* ambiguous(journal, firstId, 1_000, 2_000)
      let observations = 0
      const run = makeThreadReconciliationWorkflow(journal, {
        observeSourceThread: () => Effect.sync(() => {
          observations += 1
          return { _tag: "ExactSourceThread" as const, threadId: firstThreadId }
        }),
      })
      const result = yield* run(one(firstId, apply, 1_500))

      expect(observations).toBe(1)
      expect(result.receipts[0]).toMatchObject({ disposition: "adopted", mutated: true })
      expect(yield* journal.get(firstId)).toMatchObject({
        state: "created",
        threadId: firstThreadId,
        outcomeCode: "existing_thread",
      })
    })).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("records bounded absence before the deadline and stops at manual review after it", () =>
    withJournal(journal => Effect.gen(function* () {
      yield* ambiguous(journal, firstId, 1_000, 2_000)
      const run = makeThreadReconciliationWorkflow(journal, observer({ _tag: "Absent" }))

      const before = yield* run(one(firstId, apply, 1_500))
      expect(before.receipts[0]).toMatchObject({
        disposition: "absence_recorded",
        afterState: "unknown_external",
      })
      const after = yield* run(one(firstId, apply, 2_000))
      expect(after.receipts[0]).toMatchObject({
        disposition: "manual_review",
        afterState: "manual_review",
      })
      expect(yield* journal.get(firstId)).toMatchObject({
        state: "manual_review",
        observationCount: 2,
        outcomeCode: "ambiguous_mutation_unresolved",
      })
    })).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("bounds and deterministically orders --all including interrupted pending records", () =>
    withJournal(journal => Effect.gen(function* () {
      yield* ambiguous(journal, secondId, 1_000, 3_000)
      yield* ambiguous(journal, firstId, 1_000, 3_000)
      const pendingId = decodeDiscordSnowflake("100000000000000903")
      yield* journal.claim({ sourceMessageId: pendingId, channelId, trigger: "operator", now: 1_000, reconcileBy: 3_000 })
      const run = makeThreadReconciliationWorkflow(journal, observer({ _tag: "Absent" }))

      const result = yield* run({
        selection: { _tag: "All", limit: 3 },
        mode: { _tag: "Plan" },
        now: 2_000,
        pendingPolicy: "close-interrupted",
      })
      expect(result.truncated).toBe(false)
      expect(result.receipts).toHaveLength(3)
      expect(result.receipts[0]?.sourceMessageId).toBe(firstId)
      expect(result.receipts[2]).toMatchObject({
        sourceMessageId: pendingId,
        disposition: "would_close_interrupted_pending",
        beforeState: "pending",
        afterState: "manual_review",
        mutated: false,
      })
    })).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("closes a crash-interrupted pending claim without observing or retrying Discord create", () =>
    withJournal(journal => Effect.gen(function* () {
      const pendingId = decodeDiscordSnowflake("100000000000000903")
      yield* journal.claim({
        sourceMessageId: pendingId,
        channelId,
        trigger: "operator",
        now: 1_000,
        reconcileBy: 2_000,
      })
      let observations = 0
      const run = makeThreadReconciliationWorkflow(journal, {
        observeSourceThread: () => Effect.sync(() => {
          observations += 1
          return { _tag: "Absent" as const }
        }),
      })

      const result = yield* run({
        ...one(pendingId, apply, 1_500),
        pendingPolicy: "close-interrupted",
      })

      expect(observations).toBe(0)
      expect(result.receipts[0]).toMatchObject({
        disposition: "interrupted_pending_closed",
        mutated: true,
      })
      expect(yield* journal.get(pendingId)).toMatchObject({
        state: "manual_review",
        outcomeCode: "interrupted_before_mutation",
      })
    })).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("does not race a fresh in-flight pending claim during periodic recovery", () =>
    withJournal(journal => Effect.gen(function* () {
      const pendingId = decodeDiscordSnowflake("100000000000000903")
      yield* journal.claim({
        sourceMessageId: pendingId,
        channelId,
        trigger: "operator",
        now: 1_000,
        reconcileBy: 2_000,
      })
      const run = makeThreadReconciliationWorkflow(journal, observer({ _tag: "Absent" }))
      const result = yield* run(one(pendingId, apply, 1_500))

      expect(result.receipts[0]).toMatchObject({ disposition: "not_eligible", mutated: false })
      expect(yield* journal.get(pendingId)).toMatchObject({ state: "pending" })
    })).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("surfaces an unrun observation before the deadline without changing ambiguous state", () =>
    withJournal(journal => Effect.gen(function* () {
      const record = yield* ambiguous(journal, firstId, 1_000, 2_000)
      const run = makeThreadReconciliationWorkflow(journal, observer({
        _tag: "Unrun",
        reason: "source_anchor_not_proven",
      }))
      const result = yield* run(one(firstId, apply, 1_500))
      expect(result.receipts[0]).toMatchObject({
        disposition: "unrun",
        unrunReason: "source_anchor_not_proven",
        mutated: false,
      })
      expect(yield* journal.get(firstId)).toEqual(record)
    })).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("closes an unavailable Discord observation after the deadline without retrying create", () =>
    withJournal(journal => Effect.gen(function* () {
      yield* ambiguous(journal, firstId, 1_000, 2_000)
      let observations = 0
      const run = makeThreadReconciliationWorkflow(journal, {
        observeSourceThread: () => Effect.sync(() => {
          observations += 1
          return { _tag: "Unrun" as const, reason: "discord_read_unavailable" as const }
        }),
      })
      const result = yield* run(one(firstId, apply, 2_000))

      expect(observations).toBe(1)
      expect(result.receipts[0]).toMatchObject({
        disposition: "manual_review",
        beforeState: "creating",
        afterState: "manual_review",
        unrunReason: "discord_read_unavailable",
        mutated: true,
      })
      expect(yield* journal.get(firstId)).toMatchObject({
        state: "manual_review",
        outcomeCode: "ambiguous_mutation_unresolved",
      })
    })).pipe(Effect.provide(NodeServices.layer)),
  )
})

const apply: ReconciliationMode = { _tag: "Apply", reason: "operator reconciliation" }

const one = (
  sourceMessageId: typeof firstId,
  mode: ReconciliationMode,
  now: number,
) => ({ selection: { _tag: "One" as const, sourceMessageId }, mode, now })

const observer = (observation: ThreadObservation): ThreadObservationPort => ({
  observeSourceThread: () => Effect.succeed(observation),
})

const ambiguous = (
  journal: ThreadActionJournalService,
  sourceMessageId: typeof firstId,
  now: number,
  reconcileBy: number,
): Effect.Effect<ThreadActionRecord, import("../journal/service.ts").JournalWriteError | import("../journal/service.ts").JournalUnavailableError> =>
  Effect.gen(function* () {
    const claimed = yield* journal.claim({ sourceMessageId, channelId, trigger: "operator", now, reconcileBy })
    return yield* journal.markCreating({ sourceMessageId, claimToken: claimed.record.claimToken, now })
  })

const withJournal = <TValue, TError, TServices>(
  use: (journal: ThreadActionJournalService) => Effect.Effect<TValue, TError, TServices>,
) => Effect.scoped(Effect.gen(function* () {
  const path = `/tmp/livestore-discord-reconciliation-${randomUUID()}.sqlite`
  const fileSystem = yield* FileSystem.FileSystem
  yield* Effect.addFinalizer(() => Effect.forEach(
    [path, `${path}-wal`, `${path}-shm`],
    candidate => fileSystem.remove(candidate, { force: true }).pipe(Effect.orDie),
    { discard: true },
  ))
  const journal = yield* makeSqliteThreadActionJournal({ path })
  return yield* use(journal)
}))
