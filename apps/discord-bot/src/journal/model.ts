import * as Schema from 'effect/Schema'

import { DiscordSnowflake } from '../threading/model.ts'
export { DiscordSnowflake }

export const JournalTrigger = Schema.Literals(['automatic', 'manual', 'operator']).annotate({
  identifier: 'DiscordBot.JournalTrigger',
})
export type JournalTrigger = typeof JournalTrigger.Type

export const JournalState = Schema.Literals([
  'pending',
  'creating',
  'created',
  'unknown_external',
  'failed',
  'manual_review',
]).annotate({ identifier: 'DiscordBot.JournalState' })
export type JournalState = typeof JournalState.Type

/** Bounded, content-free reasons are safe to persist and aggregate. */
export const JournalOutcomeCode = Schema.Literals([
  'existing_thread',
  'discord_timeout',
  'discord_definitive_failure',
  'stale_creating',
  'multiple_matching_threads',
  'awaiting_remote_observation',
  'ambiguous_mutation_unresolved',
  'interrupted_before_mutation',
]).annotate({ identifier: 'DiscordBot.JournalOutcomeCode' })
export type JournalOutcomeCode = typeof JournalOutcomeCode.Type

const EpochMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand('EpochMillis'),
  Schema.annotate({ identifier: 'DiscordBot.EpochMillis' }),
)

const ObservationCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

export const ThreadActionRecord = Schema.TaggedStruct('ThreadActionRecord', {
  sourceMessageId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  state: JournalState,
  trigger: JournalTrigger,
  claimToken: Schema.String.pipe(Schema.check(Schema.isUUID(4))),
  threadId: Schema.NullOr(DiscordSnowflake),
  claimedAt: EpochMillis,
  updatedAt: EpochMillis,
  reconcileBy: EpochMillis,
  observationCount: ObservationCount,
  outcomeCode: Schema.NullOr(JournalOutcomeCode),
}).annotate({ identifier: 'DiscordBot.ThreadActionRecord' })
export type ThreadActionRecord = typeof ThreadActionRecord.Type

export interface ClaimInput {
  readonly sourceMessageId: DiscordSnowflake
  readonly channelId: DiscordSnowflake
  readonly trigger: JournalTrigger
  readonly now: number
  /** Deadline for resolving an externally ambiguous create attempt. */
  readonly reconcileBy: number
}

export interface ClaimResult {
  readonly acquired: boolean
  readonly record: ThreadActionRecord
}

export interface ClaimedActionInput {
  readonly sourceMessageId: DiscordSnowflake
  readonly claimToken: string
  readonly now: number
}

export interface MarkCreatedInput extends ClaimedActionInput {
  readonly threadId: DiscordSnowflake
  readonly resolution: 'created' | 'existing'
}

export interface MarkUnknownExternalInput extends ClaimedActionInput {
  readonly outcomeCode: 'discord_timeout' | 'stale_creating'
}

export interface MarkFailedInput extends ClaimedActionInput {
  readonly outcomeCode: 'discord_definitive_failure'
}

export interface MarkManualReviewInput extends ClaimedActionInput {
  readonly outcomeCode: 'multiple_matching_threads' | 'ambiguous_mutation_unresolved' | 'interrupted_before_mutation'
}

export interface ObserveAmbiguityInput extends ClaimedActionInput {
  readonly minimumObservations: number
}

export interface CleanupInput {
  readonly now: number
  readonly retentionMs?: number
}

export interface JournalStorageSettings {
  readonly busyTimeoutMs: number
  readonly journalMode: 'wal'
  readonly synchronous: 'full'
  readonly schemaVersion: number
}

export const decodeDiscordSnowflake = Schema.decodeUnknownSync(DiscordSnowflake)
