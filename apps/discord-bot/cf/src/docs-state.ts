import * as Effect from 'effect/Effect'
import * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore'
import * as Schema from 'effect/Schema'

import { StateFile, type DocsStateStore, type MonthlyReservation } from '../../src/docs/state.ts'

import type { CryptoService } from './crypto.ts'

const stateKey = 'livestore-discord/docs-state'
const emptyState: StateFile = { version: 1, provenance: [], quota: [], monthly: [] }

/**
 * Content-free docs quota/provenance state backed by a `KeyValueStore` — in
 * the worker that is Durable Object storage, replacing the atomic
 * temp-file-rename dance of `makeFileDocsStateStore`. A DO executes one event
 * at a time, so the multi-process writer queue collapses to plain
 * read-modify-write; prune windows are identical (24h rolling, 366d monthly).
 */
export const makeKeyValueDocsStateStore = (
  store: KeyValueStore.KeyValueStore,
  crypto: CryptoService,
): DocsStateStore => {
  const decode = Schema.decodeUnknownEffect(StateFile)
  const encode = Schema.encodeSync(StateFile)

  const load: Effect.Effect<StateFile> = Effect.flatMap(
    store.get(stateKey),
    (raw) => (raw === undefined ? Effect.succeed(emptyState) : decode(JSON.parse(raw))),
  ).pipe(
    // A missing/corrupt state degrades to the empty state; both error sources
    // (driver + schema decode) are caught by this total predicate.
    Effect.catchIf(
      (_error): _error is KeyValueStore.KeyValueStoreError | Schema.SchemaError => true,
      () => Effect.succeed(emptyState),
    ),
  )

  const persist = (value: StateFile): Effect.Effect<void> =>
    Effect.orDie(store.set(stateKey, JSON.stringify(encode(value))))

  const prune = (value: StateFile, at: number): StateFile => {
    const cutoff = at - 24 * 60 * 60 * 1_000
    return {
      version: 1,
      provenance: value.provenance.filter((entry) => entry.atMillis > cutoff),
      quota: value.quota.filter((entry) => entry.atMillis > cutoff),
      monthly: value.monthly.filter((entry) => entry.atMillis > at - 366 * 24 * 60 * 60 * 1_000),
    }
  }

  const spentInMonth = (value: StateFile, month: string): number =>
    value.monthly
      .filter((entry) => entry.status !== 'cancelled' && new Date(entry.atMillis).toISOString().slice(0, 7) === month)
      .reduce((sum, entry) => sum + entry.costUsdMicros, 0)

  return {
    // Mirrors the node store exactly: record() prunes against WALL-CLOCK
    // now(), not the sample timestamps.
    record: (input) =>
      Effect.flatMap(load, (current) => {
        const at = Date.now()
        const pruned = prune(current, at)
        return persist({
          version: 1,
          provenance: [...pruned.provenance, input.provenance],
          quota: [...pruned.quota, input.quota],
          monthly: pruned.monthly,
        })
      }),

    recent: (nowMillis: number) => Effect.map(load, (value) => prune(value, nowMillis)),

    monthlySpent: (nowMillis: number) =>
      Effect.map(
        load,
        (value) =>
          spentInMonth(prune(value, nowMillis), new Date(nowMillis).toISOString().slice(0, 7)),
      ),

    reserveMonthly: (input) =>
      Effect.flatMap(load, (current) => {
        const pruned = prune(current, input.atMillis)
        const month = new Date(input.atMillis).toISOString().slice(0, 7)
        if (spentInMonth(pruned, month) + input.costUsdMicros > input.ceilingUsdMicros) {
          return Effect.succeed<MonthlyReservation>({ _tag: 'Denied' })
        }
        return Effect.flatMap(crypto.randomUUID, (id) =>
          Effect.as(
            persist({
              ...pruned,
              monthly: [
                ...pruned.monthly,
                { id, atMillis: input.atMillis, costUsdMicros: input.costUsdMicros, status: 'reserved' },
              ],
            }),
            { _tag: 'Reserved', id } satisfies MonthlyReservation,
          ))
      }),

    /** Settles a reservation; unknown provider usage deliberately keeps its reservation. */
    settleMonthly: (input) =>
      Effect.flatMap(load, (current) => {
        // The node store settles against the PRUNED state and persists the
        // pruned file; mirror that so prune windows behave identically.
        const pruned = prune(current, Date.now())
        const index = pruned.monthly.findIndex((entry) => entry.id === input.id)
        if (index < 0) return Effect.die(new Error('Unknown monthly reservation'))
        const entry = pruned.monthly[index]
        if (entry === undefined || entry.status !== 'reserved') return Effect.void
        const monthly = [...pruned.monthly]
        monthly[index] =
          input.outcome === 'cancel'
            ? { ...entry, status: 'cancelled' }
            : { ...entry, status: 'charged', costUsdMicros: input.costUsdMicros ?? entry.costUsdMicros }
        return persist({ ...pruned, monthly })
      }),
  }
}
