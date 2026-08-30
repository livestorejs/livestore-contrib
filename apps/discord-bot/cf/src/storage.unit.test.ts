import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'
import type * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore'

import { makeFakeDoStorage } from './fake-do-storage.ts'
import {
  clearShardState,
  keyValueStoreFromDurableStorage,
  loadShardState,
  saveShardState,
  shardStateKey,
} from './storage.ts'

it.effect('KeyValueStore adapter round-trips strings and sizes over DO storage', () =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage()
    const store: KeyValueStore.KeyValueStore = keyValueStoreFromDurableStorage(storage)

    yield* store.set('a', '1')
    expect(yield* store.get('a')).toBe('1')
    expect(yield* store.size).toBe(1)

    yield* store.modify('a', (value) => `${value}0`)
    expect(yield* store.get('a')).toBe('10')

    yield* store.remove('a')
    expect(yield* store.get('a')).toBeUndefined()

    yield* store.set('b', '2')
    yield* store.clear
    expect(yield* store.size).toBe(0)
  }))

it.effect('shard state helpers share the dfx key layout', () =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage()
    const shard = [0, 1] as const

    expect(shardStateKey(shard)).toBe('dfx-shard-state-0-1')

    yield* saveShardState(storage, shard, {
      resumeUrl: 'wss://gateway',
      sessionId: 's7',
      sequence: 12,
    })
    // The raw key is what dfx's own KVSLive would read — one durable home.
    expect(yield* Effect.promise(() => storage.get(shardStateKey(shard)))).toEqual({
      resumeUrl: 'wss://gateway',
      sessionId: 's7',
      sequence: 12,
    })
    expect(yield* loadShardState(storage, shard)).toEqual({
      resumeUrl: 'wss://gateway',
      sessionId: 's7',
      sequence: 12,
    })

    yield* clearShardState(storage, shard)
    expect(yield* loadShardState(storage, shard)).toBeUndefined()
  }))
