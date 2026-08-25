import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'
import { SqliteClient } from '@effect/sql-sqlite-do'

import type { DurableObjectStorage } from '@cloudflare/workers-types'

import { decodeDiscordSnowflake, type DiscordSnowflake } from '../../src/journal/model.ts'
import { JournalTransitionError, type ThreadActionJournalService } from '../../src/journal/service.ts'
import { makeFakeDoStorage } from './fake-do-storage.ts'
import { migrateJournal, makeSqliteDoThreadActionJournal, schemaVersion } from './journal.ts'

/** Test constants arrive as raw driver strings; brand them through the schema. */
const flake = (value: string): DiscordSnowflake => decodeDiscordSnowflake(value)

const claimInput = {
  sourceMessageId: flake('1234567890123456789'),
  channelId: flake('9876543210987654321'),
  trigger: 'automatic' as const,
  now: 1000,
  reconcileBy: 60_000,
}

/**
 * Exercises the DO journal port against the hardened node:sqlite fake of the
 * Cloudflare storage surface — the same lifecycle the reviewed derisk repro
 * proved (create/migrate/claim/transitions/conflicts/retention), plus the
 * conflict semantics that moved from SQLite rowcount to read-back.
 */
const withJournal = (
  body: (journal: ThreadActionJournalService) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage()
    yield* Effect.gen(function* () {
      const client = yield* SqliteClient.make({
        // Structural stand-in for the workers-typed DurableObjectStorage;
        // the driver consumes only the `.sql` + transaction surface.
        storage: storage as unknown as DurableObjectStorage,
      }).pipe(Effect.provide(Reactivity.layer))
      yield* migrateJournal(client)
      // Tokens must be unique per call: idempotent-claim detection compares
      // the persisted claim token against a freshly generated one.
      let uuidSeq = 0
      yield* body(makeSqliteDoThreadActionJournal(client, {
        randomUUID: Effect.sync(() => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`),
        randomBytes: () => Effect.die('not used'),
        sha256Hex: () => Effect.die('not used'),
      }))
    }).pipe(Effect.ensuring(Effect.sync(() => storage.close())))
  })

it.effect('migrates the schema once and reports the version', () =>
  withJournal((journal) =>
    Effect.map(journal.inspectStorage, (settings) => {
      expect(settings.schemaVersion).toBe(schemaVersion)
    }),
  ))

it.effect('claims idempotently and transitions through the happy path', () =>
  withJournal((journal) =>
    Effect.gen(function* () {
      const first = yield* journal.claim(claimInput)
      expect(first.acquired).toBe(true)
      expect(first.record.state).toBe('pending')

      const second = yield* journal.claim(claimInput)
      expect(second.acquired).toBe(false)

      yield* journal.markCreating({
        sourceMessageId: claimInput.sourceMessageId,
        claimToken: first.record.claimToken,
        now: 1100,
      })
      const created = yield* journal.markCreated({
        sourceMessageId: claimInput.sourceMessageId,
        claimToken: first.record.claimToken,
        now: 1200,
        threadId: flake('1111111111111111111'),
        resolution: 'created',
      })
      expect(created.state).toBe('created')
      expect(created.threadId).toBe('1111111111111111111')

      expect(yield* journal.listRecoverable).toEqual([])
    }),
  ))

it.effect('rejects stale-claim transitions with a typed conflict', () =>
  withJournal((journal) =>
    Effect.gen(function* () {
      const { record } = yield* journal.claim(claimInput)
      const result = yield* Effect.result(journal.markCreating({
        sourceMessageId: claimInput.sourceMessageId,
        claimToken: 'wrong-token',
        now: 1100,
      }))
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure).toBeInstanceOf(JournalTransitionError)
        expect((result.failure as JournalTransitionError).targetState).toBe('creating')
      }
      void record
    }),
  ))

it.effect('observeAmbiguity escalates to manual review when observations are exhausted', () =>
  withJournal((journal) =>
    Effect.gen(function* () {
      const { record } = yield* journal.claim(claimInput)
      yield* journal.markCreating({
        sourceMessageId: claimInput.sourceMessageId,
        claimToken: record.claimToken,
        now: 1100,
      })

      const awaiting = yield* journal.observeAmbiguity({
        sourceMessageId: claimInput.sourceMessageId,
        claimToken: record.claimToken,
        now: 1200,
        minimumObservations: 2,
      })
      expect(awaiting.state).toBe('unknown_external')
      expect(awaiting.outcomeCode).toBe('awaiting_remote_observation')

      const exhausted = yield* journal.observeAmbiguity({
        sourceMessageId: claimInput.sourceMessageId,
        claimToken: record.claimToken,
        now: 1300,
        minimumObservations: 2,
      })
      expect(exhausted.state).toBe('manual_review')
      expect(exhausted.outcomeCode).toBe('ambiguous_mutation_unresolved')
    }),
  ))

it.effect('failed transitions leave prior rows untouched', () =>
  withJournal((journal) =>
    Effect.gen(function* () {
      yield* journal.claim(claimInput)

      const result = yield* Effect.result(journal.markCreating({
        sourceMessageId: flake('2222222222222222222'),
        claimToken: 'missing',
        now: 1500,
      }))
      expect(result._tag).toBe('Failure')
      expect(yield* journal.get(flake('1234567890123456789'))).toMatchObject({ state: 'pending' })
      expect(yield* journal.get(flake('2222222222222222222'))).toBeUndefined()
    }),
  ))

it.effect('deleteExpiredTerminal removes only terminal rows past retention', () =>
  withJournal((journal) =>
    Effect.gen(function* () {
      const { record } = yield* journal.claim(claimInput)
      yield* journal.markFailed({
        sourceMessageId: claimInput.sourceMessageId,
        claimToken: record.claimToken,
        now: 2000,
        outcomeCode: 'discord_definitive_failure',
      })

      // Row updated at 2000; age 1000 at now=3000. Shorter retention expires
      // it first; the second call then finds nothing left to delete.
      expect(yield* journal.deleteExpiredTerminal({ now: 3000, retentionMs: 500 })).toBe(1)
      expect(yield* journal.deleteExpiredTerminal({ now: 3000, retentionMs: 900 })).toBe(0)
      expect(yield* journal.get(claimInput.sourceMessageId)).toBeUndefined()
    }),
  ))
