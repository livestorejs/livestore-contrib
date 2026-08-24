import { randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import {
  type ClaimedActionInput,
  type ClaimInput,
  type CleanupInput,
  type DiscordSnowflake,
  type JournalOutcomeCode,
  type JournalState,
  type JournalStorageSettings,
  type MarkCreatedInput,
  type MarkFailedInput,
  type MarkManualReviewInput,
  type MarkUnknownExternalInput,
  type ObserveAmbiguityInput,
  ThreadActionRecord,
  type ThreadActionRecord as ThreadActionRecordType,
} from './model.ts'
import {
  JournalTransitionError,
  JournalUnavailableError,
  ThreadActionJournal,
  type ThreadActionJournalService,
} from './service.ts'

const schemaVersion = 1
const defaultBusyTimeoutMs = 5_000
export const terminalRetentionMs = 30 * 24 * 60 * 60 * 1_000

export interface SqliteJournalOptions {
  readonly path: string
  readonly busyTimeoutMs?: number
}

/** Acquires one journal connection and closes it with the surrounding Effect scope. */
export const makeSqliteThreadActionJournal = (
  options: SqliteJournalOptions,
): Effect.Effect<ThreadActionJournalService, JournalUnavailableError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => makeService(options),
      catch: (cause) => unavailable('initialize', cause),
    }).pipe(Effect.withSpan('discord.journal.initialize')),
    (service) => service.close,
  )

export const sqliteThreadActionJournalLayer = (options: SqliteJournalOptions) =>
  Layer.effect(ThreadActionJournal, makeSqliteThreadActionJournal(options))

interface InternalService extends ThreadActionJournalService {
  readonly close: Effect.Effect<void>
}

interface RawThreadActionRecord {
  readonly source_message_id: string
  readonly channel_id: string
  readonly state: string
  readonly trigger: string
  readonly claim_token: string
  readonly thread_id: string | null
  readonly claimed_at: number
  readonly updated_at: number
  readonly reconcile_by: number
  readonly observation_count: number
  readonly outcome_code: string | null
}

class InternalTransitionConflict extends Error {
  readonly sourceMessageId: string
  readonly expectedStates: ReadonlyArray<JournalState>
  readonly targetState: JournalState

  constructor(sourceMessageId: string, expectedStates: ReadonlyArray<JournalState>, targetState: JournalState) {
    super(`Journal action cannot transition from its current state to ${targetState}`)
    this.sourceMessageId = sourceMessageId
    this.expectedStates = expectedStates
    this.targetState = targetState
  }
}

const makeService = (options: SqliteJournalOptions): InternalService => {
  const busyTimeoutMs = options.busyTimeoutMs ?? defaultBusyTimeoutMs
  if (Number.isSafeInteger(busyTimeoutMs) === false || busyTimeoutMs < 0) {
    throw new TypeError('busyTimeoutMs must be a non-negative safe integer')
  }

  const database = new DatabaseSync(options.path)
  try {
    // This ordering is contractual: concurrent WAL negotiation failed before
    // the busy handler was installed in the multi-process prototype.
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = FULL')
    migrate(database)
    verifyStorage(database, busyTimeoutMs)
  } catch (cause) {
    database.close()
    throw cause
  }

  const getRecord = (sourceMessageId: DiscordSnowflake) =>
    decodeRow(database.prepare('SELECT * FROM thread_actions WHERE source_message_id = ?').get(sourceMessageId))

  const claim = Effect.fn('discord.journal.claim')((input: ClaimInput) =>
    fromDatabase('claim', () => {
      const claimToken = randomUUID()
      database.exec('BEGIN IMMEDIATE')
      try {
        database
          .prepare(`
            INSERT INTO thread_actions (
              source_message_id, channel_id, state, trigger, claim_token,
              claimed_at, updated_at, reconcile_by
            ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
            ON CONFLICT(source_message_id) DO NOTHING
          `)
          .run(
            input.sourceMessageId,
            input.channelId,
            input.trigger,
            claimToken,
            input.now,
            input.now,
            input.reconcileBy,
          )
        const record = getRecord(input.sourceMessageId)
        database.exec('COMMIT')
        if (record === undefined) throw new Error('Claim row disappeared before commit')
        return { acquired: record.claimToken === claimToken, record }
      } catch (cause) {
        rollback(database)
        throw cause
      }
    }),
  )

  const get = Effect.fn('discord.journal.get')((sourceMessageId: DiscordSnowflake) =>
    fromDatabase('get', () => getRecord(sourceMessageId)),
  )

  const listRecoverable = fromDatabase('listRecoverable', () =>
    database
      .prepare(
        "SELECT * FROM thread_actions WHERE state IN ('pending', 'creating', 'unknown_external') ORDER BY claimed_at, source_message_id",
      )
      .all()
      .map(decodeRowRequired),
  ).pipe(Effect.withSpan('discord.journal.listRecoverable'))

  const transition = (
    operation: string,
    input: ClaimedActionInput,
    from: ReadonlyArray<JournalState>,
    to: JournalState,
    patch: {
      readonly threadId?: DiscordSnowflake
      readonly outcomeCode?: JournalOutcomeCode
      readonly incrementObservation?: boolean
    } = {},
  ) =>
    transitionEffect(operation, () => {
      const placeholders = from.map(() => '?').join(', ')
      const statement = database.prepare(`
        UPDATE thread_actions
        SET state = ?, updated_at = ?,
            thread_id = COALESCE(?, thread_id),
            outcome_code = COALESCE(?, outcome_code),
            observation_count = observation_count + ?
        WHERE source_message_id = ? AND claim_token = ? AND state IN (${placeholders})
      `)
      const result = statement.run(
        to,
        input.now,
        patch.threadId ?? null,
        patch.outcomeCode ?? null,
        patch.incrementObservation === true ? 1 : 0,
        input.sourceMessageId,
        input.claimToken,
        ...from,
      )
      if (result.changes !== 1) {
        throw new InternalTransitionConflict(input.sourceMessageId, from, to)
      }
      return decodeRowRequired(
        database.prepare('SELECT * FROM thread_actions WHERE source_message_id = ?').get(input.sourceMessageId),
      )
    })

  const markCreating = (input: ClaimedActionInput) => transition('markCreating', input, ['pending'], 'creating')

  const markCreated = (input: MarkCreatedInput) =>
    transition('markCreated', input, ['pending', 'creating', 'unknown_external'], 'created', {
      threadId: input.threadId,
      ...(input.resolution === 'existing' ? { outcomeCode: 'existing_thread' as const } : {}),
    })

  const markUnknownExternal = (input: MarkUnknownExternalInput) =>
    transition('markUnknownExternal', input, ['creating', 'unknown_external'], 'unknown_external', {
      outcomeCode: input.outcomeCode,
    })

  const markFailed = (input: MarkFailedInput) =>
    transition('markFailed', input, ['pending', 'creating'], 'failed', { outcomeCode: input.outcomeCode })

  const markManualReview = (input: MarkManualReviewInput) =>
    transition('markManualReview', input, ['pending', 'creating', 'unknown_external'], 'manual_review', {
      outcomeCode: input.outcomeCode,
    })

  const observeAmbiguity = Effect.fn('discord.journal.observeAmbiguity')((input: ObserveAmbiguityInput) =>
    transitionEffect('observeAmbiguity', () => {
      if (Number.isSafeInteger(input.minimumObservations) === false || input.minimumObservations < 1) {
        throw new TypeError('minimumObservations must be a positive safe integer')
      }
      database.exec('BEGIN IMMEDIATE')
      try {
        const current = decodeRowRequired(
          database.prepare('SELECT * FROM thread_actions WHERE source_message_id = ?').get(input.sourceMessageId),
        )
        const expectedStates: ReadonlyArray<JournalState> = ['creating', 'unknown_external']
        if (current.claimToken !== input.claimToken || expectedStates.includes(current.state) === false) {
          throw new InternalTransitionConflict(input.sourceMessageId, expectedStates, 'unknown_external')
        }
        const observationCount = current.observationCount + 1
        const exhausted = observationCount >= input.minimumObservations || input.now >= current.reconcileBy
        database
          .prepare(`
            UPDATE thread_actions
            SET state = ?, updated_at = ?, observation_count = ?, outcome_code = ?
            WHERE source_message_id = ? AND claim_token = ? AND state IN ('creating', 'unknown_external')
          `)
          .run(
            exhausted === true ? 'manual_review' : 'unknown_external',
            input.now,
            observationCount,
            exhausted === true ? 'ambiguous_mutation_unresolved' : 'awaiting_remote_observation',
            input.sourceMessageId,
            input.claimToken,
          )
        const record = decodeRowRequired(
          database.prepare('SELECT * FROM thread_actions WHERE source_message_id = ?').get(input.sourceMessageId),
        )
        database.exec('COMMIT')
        return record
      } catch (cause) {
        rollback(database)
        throw cause
      }
    }),
  )

  const deleteExpiredTerminal = Effect.fn('discord.journal.deleteExpiredTerminal')((input: CleanupInput) =>
    fromDatabase('deleteExpiredTerminal', () => {
      const retentionMs = input.retentionMs ?? terminalRetentionMs
      if (Number.isSafeInteger(retentionMs) === false || retentionMs < 0) {
        throw new TypeError('retentionMs must be a non-negative safe integer')
      }
      return Number(
        database
          .prepare(
            "DELETE FROM thread_actions WHERE state IN ('created', 'failed', 'manual_review') AND updated_at <= ?",
          )
          .run(input.now - retentionMs).changes,
      )
    }),
  )

  const inspectStorage = fromDatabase('inspectStorage', () => verifyStorage(database, busyTimeoutMs)).pipe(
    Effect.withSpan('discord.journal.inspectStorage'),
  )

  return {
    claim,
    get,
    listRecoverable,
    markCreating,
    markCreated,
    markUnknownExternal,
    markFailed,
    markManualReview,
    observeAmbiguity,
    deleteExpiredTerminal,
    inspectStorage,
    close: Effect.sync(() => database.close()),
  }
}

const transitionEffect = <TValue>(operation: string, body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (cause instanceof InternalTransitionConflict) {
        return new JournalTransitionError({
          sourceMessageId: cause.sourceMessageId,
          expectedStates: cause.expectedStates,
          targetState: cause.targetState,
          message: cause.message,
        })
      }
      return unavailable(operation, cause)
    },
  }).pipe(Effect.withSpan(`discord.journal.${operation}`))

const fromDatabase = <TValue>(operation: string, body: () => TValue) =>
  Effect.try({ try: body, catch: (cause) => unavailable(operation, cause) })

const unavailable = (operation: string, cause: unknown) =>
  new JournalUnavailableError({
    operation,
    cause,
    message: `SQLite action journal failed during ${operation}`,
  })

const migrate = (database: DatabaseSync) => {
  const observedVersion = readIntegerPragma(database.prepare('PRAGMA user_version'), 'user_version')
  if (observedVersion > schemaVersion) {
    throw new Error(`Journal schema version ${observedVersion} is newer than supported version ${schemaVersion}`)
  }
  if (observedVersion === schemaVersion) return

  database.exec('BEGIN IMMEDIATE')
  try {
    // Another process may have completed the migration while this connection
    // waited for the write lock. Re-read only after acquiring that lock.
    const lockedVersion = readIntegerPragma(database.prepare('PRAGMA user_version'), 'user_version')
    if (lockedVersion > schemaVersion) {
      throw new Error(`Journal schema version ${lockedVersion} is newer than supported version ${schemaVersion}`)
    }
    if (lockedVersion === schemaVersion) {
      database.exec('COMMIT')
      return
    }
    database.exec(`
      CREATE TABLE thread_actions (
        source_message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'creating', 'created', 'unknown_external', 'failed', 'manual_review'
        )),
        trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual', 'operator')),
        claim_token TEXT NOT NULL,
        thread_id TEXT,
        claimed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reconcile_by INTEGER NOT NULL,
        observation_count INTEGER NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
        outcome_code TEXT CHECK (outcome_code IN (
          'existing_thread', 'discord_timeout', 'discord_definitive_failure', 'stale_creating',
          'multiple_matching_threads', 'awaiting_remote_observation', 'ambiguous_mutation_unresolved'
          , 'interrupted_before_mutation'
        ))
      ) STRICT;
      CREATE INDEX thread_actions_recovery ON thread_actions(state, claimed_at);
      CREATE INDEX thread_actions_retention ON thread_actions(state, updated_at);
      PRAGMA user_version = 1;
    `)
    database.exec('COMMIT')
  } catch (cause) {
    rollback(database)
    throw cause
  }
}

const verifyStorage = (database: DatabaseSync, expectedBusyTimeoutMs: number): JournalStorageSettings => {
  const busyTimeoutMs = readIntegerPragma(database.prepare('PRAGMA busy_timeout'), 'timeout')
  const journalMode = readStringPragma(database.prepare('PRAGMA journal_mode'), 'journal_mode')
  const synchronous = readIntegerPragma(database.prepare('PRAGMA synchronous'), 'synchronous')
  const actualSchemaVersion = readIntegerPragma(database.prepare('PRAGMA user_version'), 'user_version')
  if (busyTimeoutMs !== expectedBusyTimeoutMs || journalMode !== 'wal' || synchronous !== 2) {
    throw new Error('Journal durability pragmas did not take effect')
  }
  if (actualSchemaVersion !== schemaVersion) throw new Error('Journal schema migration did not reach version 1')
  return {
    busyTimeoutMs,
    journalMode: 'wal',
    synchronous: 'full',
    schemaVersion: actualSchemaVersion,
  }
}

const decodeRow = (row: unknown): ThreadActionRecordType | undefined =>
  row === undefined ? undefined : decodeRowRequired(row)

const decodeRowRequired = (row: unknown): ThreadActionRecordType => {
  const raw = Schema.decodeUnknownSync(
    Schema.Struct({
      source_message_id: Schema.String,
      channel_id: Schema.String,
      state: Schema.String,
      trigger: Schema.String,
      claim_token: Schema.String,
      thread_id: Schema.NullOr(Schema.String),
      claimed_at: Schema.Finite,
      updated_at: Schema.Finite,
      reconcile_by: Schema.Finite,
      observation_count: Schema.Finite,
      outcome_code: Schema.NullOr(Schema.String),
    }),
  )(row) satisfies RawThreadActionRecord
  return Schema.decodeUnknownSync(ThreadActionRecord)({
    _tag: 'ThreadActionRecord',
    sourceMessageId: raw.source_message_id,
    channelId: raw.channel_id,
    state: raw.state,
    trigger: raw.trigger,
    claimToken: raw.claim_token,
    threadId: raw.thread_id,
    claimedAt: raw.claimed_at,
    updatedAt: raw.updated_at,
    reconcileBy: raw.reconcile_by,
    observationCount: raw.observation_count,
    outcomeCode: raw.outcome_code,
  })
}

const readIntegerPragma = (statement: StatementSync, key: string) => {
  const row = statement.get()
  if (typeof row !== 'object' || row === null || !(key in row) || typeof row[key] !== 'number') {
    throw new Error(`SQLite returned an invalid ${key} pragma`)
  }
  return row[key]
}

const readStringPragma = (statement: StatementSync, key: string) => {
  const row = statement.get()
  if (typeof row !== 'object' || row === null || !(key in row) || typeof row[key] !== 'string') {
    throw new Error(`SQLite returned an invalid ${key} pragma`)
  }
  return row[key].toLowerCase()
}

const rollback = (database: DatabaseSync) => {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the original failure; rollback can fail when SQLite already
    // aborted the transaction during an I/O error.
  }
}
