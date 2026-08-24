import { Clock, Effect, Schema } from "effect"
import type { ThreadActionJournalService } from "../journal/service.ts"
import {
  DiscordSnowflake as JournalSnowflake,
  type JournalOutcomeCode,
} from "../journal/model.ts"
import {
  ThreadReconciliationError,
  DiscordSnowflake,
  type ThreadCandidate,
  type ThreadClaimHandle,
  type ThreadReconciliationPort,
} from "../threading/index.ts"
import { decodeDiscordSourceMessage } from "../discord/source-message.ts"
export { isDefinitiveDiscordMutationFailure } from "../discord/thread-mutation-dfx.ts"

const reconciliationWindowMillis = 5 * 60 * 1_000

export interface OperatorSourceReader {
  readonly read: (
    source: ThreadCandidate["source"],
  ) => Effect.Effect<OperatorSourceFacts, OperatorSourceReadError>
}

export interface OperatorSourceFacts {
  readonly messageKind: ThreadCandidate["messageKind"]
  readonly hasMessageReference: boolean
  readonly authorKind: ThreadCandidate["authorKind"]
  readonly existingThreadId?: ThreadCandidate["existingThreadId"]
  readonly content: string
  readonly attachmentCount: number
  readonly hasPoll: boolean
  readonly stickerCount: number
}

export class OperatorSourceReadError extends Schema.TaggedError<OperatorSourceReadError>()(
  "OperatorSourceReadError",
  {
    kind: Schema.Literals(["not_found", "invalid_source", "unavailable"]),
    message: Schema.String,
  },
) {}

interface DfxMessageReader {
  readonly getMessage: (channelId: string, messageId: string) => Effect.Effect<unknown, unknown>
}

/** Reads the exact operator source through the narrowest available DFX REST port. */
export const makeDfxOperatorSourceReader = (rest: DfxMessageReader): OperatorSourceReader => ({
  read: source => rest.getMessage(source.channelId, source.messageId).pipe(
    Effect.mapError(cause => new OperatorSourceReadError({
      kind: discordStatus(cause) === 404 ? "not_found" : "unavailable",
      message: discordStatus(cause) === 404
        ? "Discord source message does not exist"
        : "Discord source message could not be read",
    })),
    Effect.flatMap(message => Effect.try({
      try: () => decodeOperatorSource(source, message),
      catch: () => new OperatorSourceReadError({
        kind: "invalid_source",
        message: "Discord returned a source message that did not match the requested target",
      }),
    })),
    Effect.withSpan("runtime.operatorSource.read"),
  ),
})

/** Adapts the durable journal without leaking SQLite details into the use case. */
export const makeJournalReconciliation = (journal: ThreadActionJournalService): ThreadReconciliationPort => {
  const now = Clock.currentTimeMillis
  const mapError = Effect.mapError((cause: unknown) => new ThreadReconciliationError({
    code: "journal_unavailable",
    message: cause instanceof Error ? cause.message : "Action journal is unavailable",
  }))

  return {
    prepare: candidate => Effect.gen(function* () {
      const currentTime = yield* now
      const sourceMessageId = Schema.decodeUnknownSync(JournalSnowflake)(candidate.source.messageId)
      const result = yield* journal.claim({
        sourceMessageId,
        channelId: Schema.decodeUnknownSync(JournalSnowflake)(candidate.source.channelId),
        trigger: candidate.trigger._tag === "Automatic" ? "automatic" : candidate.trigger._tag === "DiscordManual" ? "manual" : "operator",
        now: currentTime,
        reconcileBy: currentTime + reconciliationWindowMillis,
      }).pipe(mapError)
      if (result.acquired) {
        return {
          _tag: "Proceed",
          handle: { sourceMessageId: candidate.source.messageId, claimToken: result.record.claimToken },
        } as const
      }
      if (result.record.state === "created" && result.record.threadId !== null) {
        return {
          _tag: "AlreadySatisfied",
          threadId: Schema.decodeUnknownSync(DiscordSnowflake)(result.record.threadId),
        } as const
      }
      return { _tag: "Ambiguous" } as const
    }).pipe(Effect.withSpan("runtime.reconciliation.prepare")),
    markCreating: handle => transition(handle, (sourceMessageId, claimToken, currentTime) =>
      journal.markCreating({ sourceMessageId, claimToken, now: currentTime })),
    markCreated: (handle, threadId) => transition(handle, (sourceMessageId, claimToken, currentTime) =>
      journal.markCreated({
        sourceMessageId,
        claimToken,
        now: currentTime,
        threadId: Schema.decodeUnknownSync(JournalSnowflake)(threadId),
        resolution: "created",
      })),
    markUnknownExternal: (handle, code) => transition(handle, (sourceMessageId, claimToken, currentTime) =>
      journal.markUnknownExternal({ sourceMessageId, claimToken, now: currentTime, outcomeCode: outcomeCode(code, true) })),
    markFailed: (handle, code) => transition(handle, (sourceMessageId, claimToken, currentTime) =>
      journal.markFailed({ sourceMessageId, claimToken, now: currentTime, outcomeCode: outcomeCode(code, false) })),
  }
}

const transition = (
  handle: ThreadClaimHandle,
  write: (sourceMessageId: typeof JournalSnowflake.Type, claimToken: string, now: number) => Effect.Effect<unknown, unknown>,
) => Effect.gen(function* () {
  const sourceMessageId = Schema.decodeUnknownSync(JournalSnowflake)(handle.sourceMessageId)
  yield* write(sourceMessageId, handle.claimToken, yield* Clock.currentTimeMillis).pipe(
    Effect.mapError(cause => new ThreadReconciliationError({
      code: "journal_transition_failed",
      message: cause instanceof Error ? cause.message : "Action journal transition failed",
    })),
  )
}).pipe(Effect.withSpan("runtime.reconciliation.transition"))

function outcomeCode(code: string, ambiguous: true): "discord_timeout" | "stale_creating"
function outcomeCode(code: string, ambiguous: false): "discord_definitive_failure"
function outcomeCode(code: string, ambiguous: boolean): JournalOutcomeCode {
  return ambiguous ? (code.includes("stale") ? "stale_creating" : "discord_timeout") : "discord_definitive_failure"
}


export const candidateForOperator = (
  source: ThreadCandidate["source"],
  environment: ThreadCandidate["environment"],
  requestedTitle: string | undefined,
  reason: string,
  principal: string,
  authorized: boolean,
  facts: OperatorSourceFacts,
): ThreadCandidate => ({
  environment,
  source,
  sourceChannelKind: "GuildText",
  ...facts,
  trigger: { _tag: "Operator", principal, authorized, reason, requestedTitle },
})

const decodeOperatorSource = (source: ThreadCandidate["source"], message: unknown): OperatorSourceFacts => {
  const facts = decodeDiscordSourceMessage(source, message)
  return {
    messageKind: facts.isReply ? "Reply" : facts.messageType === 0 ? "Default" : "System",
    hasMessageReference: facts.isReply,
    authorKind: facts.authorIsBot
      ? "Bot"
      : facts.hasWebhookAuthor
        ? "Webhook"
        : facts.hasApplicationAuthor
          ? "Application"
          : "Human",
    existingThreadId: facts.existingThreadId,
    content: facts.content,
    attachmentCount: facts.attachmentCount,
    hasPoll: facts.hasPoll,
    stickerCount: facts.stickerCount,
  }
}

const discordStatus = (cause: unknown): number | undefined => {
  if (!isRecord(cause) || !isRecord(cause.response)) return undefined
  return typeof cause.response.status === "number" ? cause.response.status : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
