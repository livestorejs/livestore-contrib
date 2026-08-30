import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import { decodeDiscordSnowflake } from './model.ts'
import { JournalTransitionError, JournalUnavailableError, type ThreadActionJournalService } from './service.ts'
import { makeSqliteThreadActionJournal, terminalRetentionMs } from './sqlite.ts'

const sourceMessageId = decodeDiscordSnowflake('100000000000000001')
const channelId = decodeDiscordSnowflake('100000000000000002')
const threadId = decodeDiscordSnowflake('100000000000000003')

describe('SQLite thread action journal', () => {
  it.effect('reports unavailable storage as a typed readiness failure', () =>
    Effect.gen(function* () {
      const missingParent = `/tmp/livestore-discord-missing-${randomUUID()}/journal.sqlite`
      const failure = yield* Effect.scoped(makeSqliteThreadActionJournal({ path: missingParent })).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(JournalUnavailableError)
      expect(failure.operation).toBe('initialize')
    }),
  )

  it.effect('installs durability settings before atomically admitting one claimant', () =>
    withJournal((journal) =>
      Effect.gen(function* () {
        const first = yield* journal.claim({
          sourceMessageId,
          channelId,
          trigger: 'automatic',
          now: 1_000,
          reconcileBy: 10_000,
        })
        const duplicate = yield* journal.claim({
          sourceMessageId,
          channelId,
          trigger: 'manual',
          now: 1_001,
          reconcileBy: 10_000,
        })

        expect(first.acquired).toBe(true)
        expect(duplicate.acquired).toBe(false)
        expect(duplicate.record.claimToken).toBe(first.record.claimToken)
        expect(yield* journal.inspectStorage).toEqual({
          busyTimeoutMs: 5_000,
          journalMode: 'wal',
          synchronous: 'full',
          schemaVersion: 1,
        })
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('never reopens an ambiguous mutation and stops after bounded observations', () =>
    withJournal((journal) =>
      Effect.gen(function* () {
        const claim = yield* journal.claim({
          sourceMessageId,
          channelId,
          trigger: 'automatic',
          now: 2_000,
          reconcileBy: 20_000,
        })
        const claimed = { sourceMessageId, claimToken: claim.record.claimToken }
        expect((yield* journal.markCreating({ ...claimed, now: 2_001 })).state).toBe('creating')
        expect(
          (yield* journal.markUnknownExternal({ ...claimed, now: 2_002, outcomeCode: 'discord_timeout' })).state,
        ).toBe('unknown_external')
        const firstObservation = yield* journal.observeAmbiguity({
          ...claimed,
          now: 2_003,
          minimumObservations: 2,
        })
        const secondObservation = yield* journal.observeAmbiguity({
          ...claimed,
          now: 2_004,
          minimumObservations: 2,
        })

        expect(firstObservation.state).toBe('unknown_external')
        expect(firstObservation.observationCount).toBe(1)
        expect(secondObservation.state).toBe('manual_review')
        expect(secondObservation.observationCount).toBe(2)
        expect(secondObservation.outcomeCode).toBe('ambiguous_mutation_unresolved')

        const conflict = yield* Effect.flip(journal.markCreating({ ...claimed, now: 2_005 }))
        expect(conflict).toBeInstanceOf(JournalTransitionError)
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('adopts a deterministically found thread after restart without another create state', () =>
    Effect.gen(function* () {
      const { path } = yield* testDatabasePath
      const claimToken = yield* Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* makeSqliteThreadActionJournal({ path })
          const claim = yield* journal.claim({
            sourceMessageId,
            channelId,
            trigger: 'operator',
            now: 3_000,
            reconcileBy: 30_000,
          })
          yield* journal.markCreating({ sourceMessageId, claimToken: claim.record.claimToken, now: 3_001 })
          return claim.record.claimToken
        }),
      )

      const recovered = yield* Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* makeSqliteThreadActionJournal({ path })
          const records = yield* journal.listRecoverable
          expect(records.map((record) => record.state)).toEqual(['creating'])
          yield* journal.markUnknownExternal({
            sourceMessageId,
            claimToken,
            now: 3_002,
            outcomeCode: 'stale_creating',
          })
          return yield* journal.markCreated({
            sourceMessageId,
            claimToken,
            now: 3_003,
            threadId,
            resolution: 'existing',
          })
        }),
      )

      expect(recovered.state).toBe('created')
      expect(recovered.threadId).toBe(threadId)
      expect(recovered.outcomeCode).toBe('existing_thread')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('deletes only terminal rows older than the 30-day retention boundary', () =>
    withJournal((journal) =>
      Effect.gen(function* () {
        const oldNow = 10
        const terminal = yield* journal.claim({
          sourceMessageId,
          channelId,
          trigger: 'manual',
          now: oldNow,
          reconcileBy: 100,
        })
        yield* journal.markFailed({
          sourceMessageId,
          claimToken: terminal.record.claimToken,
          now: oldNow,
          outcomeCode: 'discord_definitive_failure',
        })
        const recoverableId = decodeDiscordSnowflake('100000000000000004')
        yield* journal.claim({
          sourceMessageId: recoverableId,
          channelId,
          trigger: 'automatic',
          now: oldNow,
          reconcileBy: 100,
        })

        expect(yield* journal.deleteExpiredTerminal({ now: oldNow + terminalRetentionMs })).toBe(1)
        expect(yield* journal.get(sourceMessageId)).toBeUndefined()
        expect((yield* journal.get(recoverableId))?.state).toBe('pending')
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect(
    'serializes automatic, manual, and operator claims across OS processes',
    () =>
      Effect.gen(function* () {
        const { path } = yield* testDatabasePath
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const worker = fileURLToPath(new URL('./claim-worker.fixture.ts', import.meta.url))
        const outputs = yield* Effect.forEach(
          ['automatic', 'manual', 'operator', 'automatic', 'manual', 'operator'] as const,
          (trigger) =>
            spawner.string(
              ChildProcess.make(process.execPath, [
                '--experimental-strip-types',
                worker,
                path,
                sourceMessageId,
                channelId,
                trigger,
              ]),
            ),
          { concurrency: 'unbounded' },
        )
        const WorkerResult = Schema.fromJsonString(Schema.Struct({ acquired: Schema.Boolean }))
        const results = outputs.map((output) => Schema.decodeUnknownSync(WorkerResult)(output.trim()))
        expect(results.filter((result) => result.acquired)).toHaveLength(1)

        yield* Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* makeSqliteThreadActionJournal({ path })
            expect(yield* journal.listRecoverable).toHaveLength(1)
          }),
        )
      }).pipe(Effect.provide(NodeServices.layer)),
    20_000,
  )
})

const withJournal = <TValue, TError, TServices>(
  use: (journal: ThreadActionJournalService) => Effect.Effect<TValue, TError, TServices>,
) =>
  Effect.gen(function* () {
    const { path } = yield* testDatabasePath
    const journal = yield* makeSqliteThreadActionJournal({ path })
    return yield* use(journal)
  })

const testDatabasePath = Effect.gen(function* () {
  const path = `/tmp/livestore-discord-journal-${randomUUID()}.sqlite`
  const fileSystem = yield* FileSystem.FileSystem
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [path, `${path}-wal`, `${path}-shm`],
      (candidate) => fileSystem.remove(candidate, { force: true }).pipe(Effect.orDie),
      { discard: true },
    ),
  )
  return { path }
})
