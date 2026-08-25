import * as Effect from 'effect/Effect'
import * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore'

import type { ShardState } from 'dfx/DiscordGateway/Shard/StateStore'

/**
 * Structural slice of the Cloudflare Durable Object storage API that the bot
 * state consumes. Deliberately narrower than `DurableObjectStorage` so tests
 * can substitute an in-memory fake without pulling workers types into unit
 * test files, and so the adapter documents exactly which operations the bot
 * relies on.
 */
export interface DurableStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: <T>(key: string, value: T) => Promise<T>
  readonly delete: (key: string) => Promise<boolean>
  readonly list: <T>(options?: { readonly prefix?: string }) => Promise<Map<string, T>>
}

/**
 * Lifts DO key/value storage into an Effect `KeyValueStore`. String values map
 * 1:1; binary values ride through UTF-8 because every consumer here
 * (`dfx` ShardStateStore, docs quota state) stores JSON strings only. The DO's
 * single-threaded execution model serializes writers, so no extra queueing is
 * needed — unlike the multi-process file store this replaces.
 */
export const keyValueStoreFromDurableStorage = (storage: DurableStorage): KeyValueStore.KeyValueStore =>
  KeyValueStore.makeStringOnly({
    get: (key) => Effect.promise(() => storage.get<string>(key)),
    set: (key, value) => Effect.asVoid(Effect.promise(() => storage.put(key, value))),
    remove: (key) => Effect.asVoid(Effect.promise(() => storage.delete(key))),
    clear: Effect.gen(function* () {
      const entries = yield* Effect.promise(() => storage.list())
      for (const key of entries.keys()) {
        yield* Effect.promise(() => storage.delete(key))
      }
    }),
    size: Effect.map(Effect.promise(() => storage.list()), (entries) => entries.size),
  })

/** Same key layout dfx's own `ShardStateStore.KVSLive` derives — both writers share one durable home. */
export const shardStateKey = (shard: readonly [id: number, count: number]): string =>
  `dfx-shard-state-${shard[0]}-${shard[1]}`

export const loadShardState = (
  storage: DurableStorage,
  shard: readonly [id: number, count: number],
): Effect.Effect<ShardState | undefined> =>
  Effect.map(
    Effect.promise(() => storage.get<ShardState>(shardStateKey(shard))),
    (state) => state,
  )

export const saveShardState = (
  storage: DurableStorage,
  shard: readonly [id: number, count: number],
  state: ShardState,
): Effect.Effect<void> => Effect.asVoid(Effect.promise(() => storage.put(shardStateKey(shard), state)))

export const clearShardState = (
  storage: DurableStorage,
  shard: readonly [id: number, count: number],
): Effect.Effect<void> => Effect.asVoid(Effect.promise(() => storage.delete(shardStateKey(shard))))
