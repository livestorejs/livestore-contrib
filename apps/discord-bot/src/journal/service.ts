import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  ClaimedActionInput,
  ClaimInput,
  ClaimResult,
  CleanupInput,
  JournalStorageSettings,
  MarkCreatedInput,
  MarkFailedInput,
  MarkManualReviewInput,
  MarkUnknownExternalInput,
  ObserveAmbiguityInput,
  ThreadActionRecord,
} from './model.ts'

export class JournalUnavailableError extends Schema.TaggedError<JournalUnavailableError>()('JournalUnavailableError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class JournalTransitionError extends Schema.TaggedError<JournalTransitionError>()('JournalTransitionError', {
  sourceMessageId: Schema.String,
  expectedStates: Schema.Array(Schema.String),
  targetState: Schema.String,
  message: Schema.String,
}) {}

export type JournalWriteError = JournalUnavailableError | JournalTransitionError

export interface ThreadActionJournalService {
  readonly claim: (input: ClaimInput) => Effect.Effect<ClaimResult, JournalUnavailableError>
  readonly get: (
    sourceMessageId: ClaimInput['sourceMessageId'],
  ) => Effect.Effect<ThreadActionRecord | undefined, JournalUnavailableError>
  readonly listRecoverable: Effect.Effect<ReadonlyArray<ThreadActionRecord>, JournalUnavailableError>
  readonly markCreating: (input: ClaimedActionInput) => Effect.Effect<ThreadActionRecord, JournalWriteError>
  readonly markCreated: (input: MarkCreatedInput) => Effect.Effect<ThreadActionRecord, JournalWriteError>
  readonly markUnknownExternal: (
    input: MarkUnknownExternalInput,
  ) => Effect.Effect<ThreadActionRecord, JournalWriteError>
  readonly markFailed: (input: MarkFailedInput) => Effect.Effect<ThreadActionRecord, JournalWriteError>
  readonly markManualReview: (input: MarkManualReviewInput) => Effect.Effect<ThreadActionRecord, JournalWriteError>
  /** Records one negative remote lookup and stops at manual review when bounded recovery is exhausted. */
  readonly observeAmbiguity: (input: ObserveAmbiguityInput) => Effect.Effect<ThreadActionRecord, JournalWriteError>
  readonly deleteExpiredTerminal: (input: CleanupInput) => Effect.Effect<number, JournalUnavailableError>
  readonly inspectStorage: Effect.Effect<JournalStorageSettings, JournalUnavailableError>
}

export class ThreadActionJournal extends Context.Service<ThreadActionJournal, ThreadActionJournalService>()(
  'livestore-discord/ThreadActionJournal',
) {}
