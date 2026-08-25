import type { SqliteClient } from '@effect/sql-sqlite-do/SqliteClient'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  type ClaimedActionInput,
  type ClaimInput,
  DiscordSnowflake,
  type CleanupInput,
  JournalOutcomeCode,
  JournalState,
  JournalTrigger,
  type JournalStorageSettings,
  ThreadActionRecord,
  type MarkCreatedInput,
  type MarkFailedInput,
  type MarkManualReviewInput,
  type MarkUnknownExternalInput,
  type ObserveAmbiguityInput,
  type ThreadActionRecord as ThreadActionRecordType,
} from '../../src/journal/model.ts'
import { JournalTransitionError, JournalUnavailableError } from '../../src/journal/service.ts'

import type { CryptoService } from './crypto.ts'
import type { ThreadActionJournalService } from '../../src/journal/service.ts'

type JournalWriteError = JournalUnavailableError | JournalTransitionError

export const schemaVersion = 1
export const terminalRetentionMs = 30 * 24 * 60 * 60 * 1_000

/**
 * Hand-run DDL for the thread-action journal over a Cloudflare Durable Object
 * SQLite backend. Mirrors `src/journal/sqlite.ts` `migrate()` statement for
 * statement, but each statement goes through the SQL driver separately: the
 * DO `SqlStorage.exec` surface (and the hardened test fake) rejects
 * multi-statement strings, unlike node:sqlite's `exec`.
 */
const readMetaVersion = (
  client: SqliteClient,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlErrorShape> =>
  exec(client, "SELECT value FROM journal_meta WHERE key = 'user_version'")

export const migrateJournal = (
  client: SqliteClient,
): Effect.Effect<void, JournalUnavailableError> =>
  Effect.gen(function* () {
    yield* exec(client,
      'CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).pipe(Effect.catchIf(isSqlError, (cause) => unavailable('initialize', cause)))
    const observedVersion = readUserVersion(yield* readMetaVersion(client).pipe(
      Effect.catchIf(isSqlError, (cause) => unavailable('initialize', cause)),
    ))
    if (observedVersion > schemaVersion) {
      return yield* unavailable(
        'initialize',
        new Error(`Journal schema version ${observedVersion} is newer than supported version ${schemaVersion}`),
      )
    }
    if (observedVersion === schemaVersion) return

    yield* runInTransaction(
      client,
      Effect.gen(function* () {
        // The DO serializes writers per object, so the multi-process re-check
        // under the write lock collapses to a plain re-read.
        const lockedVersion = readUserVersion(yield* readMetaVersion(client))
        if (lockedVersion > schemaVersion) {
          return yield* unavailable(
            'initialize',
            new Error(`Journal schema version ${lockedVersion} is newer than supported version ${schemaVersion}`),
          )
        }
        if (lockedVersion === schemaVersion) return

        yield* exec(client, `CREATE TABLE IF NOT EXISTS thread_actions (
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
            'multiple_matching_threads', 'awaiting_remote_observation', 'ambiguous_mutation_unresolved',
            'interrupted_before_mutation'
          ))
        ) STRICT`)
        yield* exec(client, 'CREATE INDEX IF NOT EXISTS thread_actions_recovery ON thread_actions(state, claimed_at)')
        yield* exec(client, 'CREATE INDEX IF NOT EXISTS thread_actions_retention ON thread_actions(state, updated_at)')
        // DO SQL storage rejects PRAGMA statements, so the schema version
        // lives in a meta table instead of SQLite's user_version header.
        yield* exec(client, "INSERT INTO journal_meta (key, value) VALUES ('user_version', '" + String(schemaVersion) + "')")
      }),
    ).pipe(Effect.mapError((cause: JournalUnavailableError | SqlErrorShape) =>
      isSqlError(cause) ? unavailable('initialize', cause) : cause,
    ))
  }).pipe(Effect.withSpan('discord.journal.initialize'))

/**
 * Builds the journal service over a DO SQLite client.
 *
 * The schema version lives in the journal_meta table: DO SQL storage rejects
 * PRAGMA statements, so SQLite's user_version header is unavailable here. Construct the client
 * with the FULL DurableObjectStorage — `withTransaction` breaks on bare
 * `.sql`. Transition conflicts are detected by read-back instead of SQLite
 * rowcount: the DO driver surfaces result rows only, never mutation counts,
 * and every check runs inside the DO's serialized transactions.
 */
export const makeSqliteDoThreadActionJournal = (
  client: SqliteClient,
  crypto: CryptoService,
): ThreadActionJournalService => ({
  claim: (input: ClaimInput) =>
    runInTransaction(
      client,
      Effect.gen(function* () {
        const claimToken = yield* crypto.randomUUID
        yield* exec(client, `
          INSERT INTO thread_actions (
            source_message_id, channel_id, state, trigger, claim_token,
            claimed_at, updated_at, reconcile_by
          ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
          ON CONFLICT(source_message_id) DO NOTHING
        `, [input.sourceMessageId, input.channelId, input.trigger, claimToken, input.now, input.now, input.reconcileBy])
        const record = yield* getRecord(client, input.sourceMessageId)
        if (record === undefined) {
          return yield* unavailable('claim', new Error('Claim row disappeared before commit'))
        }
        return { acquired: record.claimToken === claimToken, record }
      }),
    ).pipe(
      Effect.catchIf(isSqlError, (cause) => unavailable('claim', cause)),
      Effect.withSpan('discord.journal.claim'),
    ),

  get: (sourceMessageId: DiscordSnowflake) => getRecord(client, sourceMessageId),

  listRecoverable: Effect.flatMap(
    exec(client, `SELECT * FROM thread_actions WHERE state IN ('pending', 'creating', 'unknown_external')
                  ORDER BY claimed_at, source_message_id`),
    (rows) =>
      // Row decoding validates against the record schema; a malformed row
      // folds into the same domain-unavailable channel as driver failures.
      Effect.try({
        try: () => rows.map(decodeRowRequired),
        catch: (cause) => unavailable('listRecoverable', cause),
      }),
  ).pipe(
    Effect.catchIf(isSqlError, (cause) => unavailable('listRecoverable', cause)),
    Effect.withSpan('discord.journal.listRecoverable'),
  ),

  markCreating: (input: ClaimedActionInput) => transition(client, 'markCreating', input, ['pending'], 'creating', {}),

  markCreated: (input: MarkCreatedInput) =>
    transition(
      client,
      'markCreated',
      input,
      ['pending', 'creating', 'unknown_external'],
      'created',
      {
        threadId: input.threadId,
        ...(input.resolution === 'existing' ? { outcomeCode: 'existing_thread' as const } : {}),
      },
    ),

  markUnknownExternal: (input: MarkUnknownExternalInput) =>
    transition(
      client,
      'markUnknownExternal',
      input,
      ['creating', 'unknown_external'],
      'unknown_external',
      { outcomeCode: input.outcomeCode },
    ),

  markFailed: (input: MarkFailedInput) =>
    transition(client, 'markFailed', input, ['pending', 'creating'], 'failed', { outcomeCode: input.outcomeCode }),

  markManualReview: (input: MarkManualReviewInput) =>
    transition(
      client,
      'markManualReview',
      input,
      ['pending', 'creating', 'unknown_external'],
      'manual_review',
      { outcomeCode: input.outcomeCode },
    ),

  observeAmbiguity: (input: ObserveAmbiguityInput) =>
    runInTransaction(
      client,
      Effect.gen(function* () {
        if (Number.isSafeInteger(input.minimumObservations) === false || input.minimumObservations < 1) {
          return yield* unavailable(
            'observeAmbiguity',
            new TypeError('minimumObservations must be a positive safe integer'),
          )
        }
        const current = yield* getRecordRequired(client, 'observeAmbiguity', input.sourceMessageId)
        const expectedStates: ReadonlyArray<JournalState> = ['creating', 'unknown_external']
        if (current.claimToken !== input.claimToken || expectedStates.includes(current.state) === false) {
          return yield* conflict(input.sourceMessageId, expectedStates, 'unknown_external')
        }
        const observationCount = current.observationCount + 1
        const exhausted = observationCount >= input.minimumObservations || input.now >= current.reconcileBy
        yield* exec(client, `
          UPDATE thread_actions
          SET state = ?, updated_at = ?, observation_count = ?, outcome_code = ?
          WHERE source_message_id = ? AND claim_token = ? AND state IN ('creating', 'unknown_external')
        `, [
          exhausted ? 'manual_review' : 'unknown_external',
          input.now,
          observationCount,
          exhausted ? 'ambiguous_mutation_unresolved' : 'awaiting_remote_observation',
          input.sourceMessageId,
          input.claimToken,
        ])
        return yield* getRecordRequired(client, 'observeAmbiguity', input.sourceMessageId)
      }),
    ).pipe(
      Effect.catchIf(isSqlError, (cause) => unavailable('observeAmbiguity', cause)),
      Effect.withSpan('discord.journal.observeAmbiguity'),
    ),

  deleteExpiredTerminal: (input: CleanupInput) =>
    runInTransaction(
      client,
      Effect.gen(function* () {
        const retentionMs = input.retentionMs ?? terminalRetentionMs
        if (Number.isSafeInteger(retentionMs) === false || retentionMs < 0) {
          return yield* unavailable(
            'deleteExpiredTerminal',
            new TypeError('retentionMs must be a non-negative safe integer'),
          )
        }
        const doomed = countFrom(yield* exec(
          client,
          `SELECT COUNT(*) AS n FROM thread_actions WHERE state IN ('created', 'failed', 'manual_review') AND updated_at <= ?`,
          [input.now - retentionMs],
        ))
        yield* exec(
          client,
          `DELETE FROM thread_actions WHERE state IN ('created', 'failed', 'manual_review') AND updated_at <= ?`,
          [input.now - retentionMs],
        )
        return doomed
      }),
    ).pipe(
      Effect.catchIf(isSqlError, (cause) => unavailable('deleteExpiredTerminal', cause)),
      Effect.withSpan('discord.journal.deleteExpiredTerminal'),
    ),

  /**
   * DO SQLite is single-connection and always WAL-backed with synchronous
   * durability by platform contract — the pragmas the node journal negotiated
   * at runtime are guarantees here, so only the schema version is verified.
   */
  inspectStorage: Effect.map(
    readMetaVersion(client),
    (rows): JournalStorageSettings => ({
      busyTimeoutMs: 0,
      journalMode: 'wal',
      synchronous: 'full',
      schemaVersion: readUserVersion(rows),
    }),
  ).pipe(
    Effect.catchIf(isSqlError, (cause) => unavailable('inspectStorage', cause)),
    Effect.withSpan('discord.journal.inspectStorage'),
  ),
})

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface SqlErrorShape {
  readonly _tag: string
}

const isSqlError = (cause: unknown): cause is SqlErrorShape =>
  typeof cause === 'object' && cause !== null && '_tag' in cause && cause._tag === 'SqlError'

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

const rowSchema = Schema.Struct({
  source_message_id: DiscordSnowflake,
  channel_id: DiscordSnowflake,
  state: JournalState,
  trigger: JournalTrigger,
  claim_token: Schema.String,
  thread_id: Schema.NullOr(DiscordSnowflake),
  claimed_at: Schema.Finite,
  updated_at: Schema.Finite,
  reconcile_by: Schema.Finite,
  observation_count: Schema.Finite,
  outcome_code: Schema.NullOr(JournalOutcomeCode),
})

const decodeRowRequired = (row: unknown): ThreadActionRecordType => {
  const raw = Schema.decodeUnknownSync(rowSchema)(row) satisfies RawThreadActionRecord
  return Schema.decodeSync(ThreadActionRecord)({
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

/**
 * Runs one driver statement. The reviewed derisk verdict: do NOT branch on
 * SqlError reason tags (classification degrades everything to UnknownError);
 * failures surface as SqlError and callers map them to
 * JournalUnavailableError with the cause preserved.
 */
const exec = (
  client: SqliteClient,
  statement: string,
  params: ReadonlyArray<string | number | null> = [],
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlErrorShape> => client.unsafe(statement, params)

/**
 * Wraps one effect in a driver transaction. The driver appends its own
 * SqlError channel for transaction-level failures (lock loss, rollback);
 * callers catch that tag and fold it into their domain error.
 */
const runInTransaction = <A, E, R>(
  client: SqliteClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlErrorShape, R> => client.withTransaction(effect)

const unavailable = (operation: string, cause: unknown): JournalUnavailableError =>
  new JournalUnavailableError({
    operation,
    cause,
    message: `SQLite action journal failed during ${operation}`,
  })

const conflict = (
  sourceMessageId: string,
  expectedStates: ReadonlyArray<JournalState>,
  targetState: JournalState,
): Effect.Effect<never, JournalTransitionError> =>
  Effect.fail(new JournalTransitionError({
    sourceMessageId,
    expectedStates: [...expectedStates],
    targetState,
    message: `Journal action cannot transition from its current state to ${targetState}`,
  }))

const getRecord = (
  client: SqliteClient,
  sourceMessageId: DiscordSnowflake,
): Effect.Effect<ThreadActionRecordType | undefined, JournalUnavailableError> =>
  Effect.map(
    exec(client, 'SELECT * FROM thread_actions WHERE source_message_id = ?', [sourceMessageId]),
    decodeRow,
  ).pipe(Effect.catchIf(isSqlError, (cause) => unavailable('get', cause)))

const decodeRow = (rows: ReadonlyArray<Record<string, unknown>>): ThreadActionRecordType | undefined => {
  const first = rows[0]
  return first === undefined ? undefined : decodeRowRequired(first)
}

const getRecordRequired = (
  client: SqliteClient,
  operation: string,
  sourceMessageId: DiscordSnowflake,
): Effect.Effect<ThreadActionRecordType, SqlErrorShape | JournalUnavailableError> =>
  Effect.flatMap(getRecord(client, sourceMessageId), (record) =>
    record === undefined
      ? unavailable(operation, new Error(`No journal row for source message ${sourceMessageId}`))
      : Effect.succeed(record))

const countFrom = (rows: ReadonlyArray<Record<string, unknown>>): number => {
  const first = rows[0]
  return typeof first?.n === 'number' ? first.n : 0
}

const transition = (
  client: SqliteClient,
  operation: string,
  input: ClaimedActionInput,
  from: ReadonlyArray<JournalState>,
  to: JournalState,
  patch: {
    readonly threadId?: DiscordSnowflake
    readonly outcomeCode?: JournalOutcomeCode
    readonly incrementObservation?: boolean
  },
): Effect.Effect<ThreadActionRecordType, JournalWriteError> =>
  runInTransaction(
    client,
    Effect.gen(function* () {
      const current = yield* getRecordRequired(client, operation, input.sourceMessageId)
      if (current.claimToken !== input.claimToken || from.includes(current.state) === false) {
        return yield* conflict(input.sourceMessageId, from, to)
      }
      yield* exec(client, `
        UPDATE thread_actions
        SET state = ?, updated_at = ?,
            thread_id = COALESCE(?, thread_id),
            outcome_code = COALESCE(?, outcome_code),
            observation_count = observation_count + ?
        WHERE source_message_id = ? AND claim_token = ?
      `, [
        to,
        input.now,
        patch.threadId ?? null,
        patch.outcomeCode ?? null,
        patch.incrementObservation === true ? 1 : 0,
        input.sourceMessageId,
        input.claimToken,
      ])
      return yield* getRecordRequired(client, operation, input.sourceMessageId)
    }),
  ).pipe(
    Effect.catchIf(isSqlError, (cause) => unavailable(operation, cause)),
    Effect.withSpan(`discord.journal.${operation}`),
  )

const readUserVersion = (rows: ReadonlyArray<Record<string, unknown>>): number => {
  // Absent row means fresh storage at version 0.
  if (rows.length === 0) return 0
  const first = rows[0] as { readonly value?: unknown }
  const parsed = typeof first.value === 'string' ? Number(first.value) : Number.NaN
  if (Number.isInteger(parsed) === false || parsed < 0) {
    throw new Error('journal_meta has an invalid user_version value')
  }
  return parsed
}
