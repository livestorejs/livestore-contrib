import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { makeGatewayLease } from './gateway-lease.ts'

const makeLeaseFixture = (stage: 'staging' | 'production' = 'staging') =>
  Effect.gen(function* () {
    const state = { now: 1000, alarm: null as number | null, stops: 0, stopFailure: false }
    const values = new Map<string, unknown>()
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, value)
        return value
      },
      delete: async (key: string) => values.delete(key),
      getAlarm: async () => state.alarm,
      setAlarm: async (when: number) => {
        state.alarm = when
      },
      deleteAlarm: async () => {
        state.alarm = null
      },
    }
    const reload = makeGatewayLease(
      stage,
      storage,
      Effect.sync(() => {
        if (state.stopFailure) throw new Error('Failed to close the gateway')
        state.stops++
      }),
      () => state.now,
    )
    const lease = yield* reload
    return { lease, reload, state }
  })

const parked = Effect.succeed('parked')
const observe = (expiresAt: number | undefined) => Effect.succeed(expiresAt)

it.effect('clears an inherited alarm and keeps parked staging inert', () =>
  Effect.gen(function* () {
    const { lease, state } = yield* makeLeaseFixture()
    state.alarm = state.now
    expect(yield* lease.whileActive(observe, parked)).toBe('parked')
    expect(state).toMatchObject({ alarm: null, stops: 1 })
    expect(yield* lease.whileActive(observe, parked)).toBe('parked')
    expect(state).toMatchObject({ alarm: null, stops: 1 })
  }),
)

it.effect('persists one deadline across owner retries and isolate recreation', () =>
  Effect.gen(function* () {
    const { lease, reload, state } = yield* makeLeaseFixture()
    const activate = { owner: 'ci-123-1', ttlSeconds: 90 }
    const first = yield* lease.activate(activate)
    expect(first).toEqual({
      status: 200,
      ok: true,
      body: { state: 'active', owner: activate.owner, expiresAt: 91_000 },
    })
    expect(state.alarm).toBe(state.now)
    state.now += 3000
    const reloaded = yield* reload
    expect(yield* reloaded.activate(activate)).toEqual(first)
    expect(yield* reloaded.whileActive(observe, parked)).toBe(91_000)
    state.now = 91_000
    expect(yield* reloaded.whileActive(observe, parked)).toBe('parked')
    expect(state).toMatchObject({ alarm: null, stops: 1 })
    expect(yield* reloaded.whileActive(observe, parked)).toBe('parked')
  }),
)

it.effect('serializes competing activations and fences stale cleanup', () =>
  Effect.gen(function* () {
    const { lease, state } = yield* makeLeaseFixture()
    const owners = ['first', 'second']
    const results = yield* Effect.all(
      owners.map((owner) => lease.activate({ owner, ttlSeconds: 90 })),
      { concurrency: 'unbounded' },
    )
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    const winner = owners[results.findIndex((result) => result.ok)]!
    const loser = owners.find((owner) => owner !== winner)!
    expect((yield* lease.park({ owner: loser })).status).toBe(409)
    expect(state.stops).toBe(0)
    expect((yield* lease.park({ owner: winner })).body).toEqual({ state: 'parked' })
    expect((yield* lease.park({ owner: winner })).body).toEqual({ state: 'parked' })
    expect(state).toMatchObject({ alarm: null, stops: 1 })
    expect((yield* lease.activate({ owner: loser, ttlSeconds: 90 })).status).toBe(200)
    expect((yield* lease.park({ owner: winner })).status).toBe(409)
  }),
)

it.effect('retries closing a gateway if the expiry alarm could not stop it', () =>
  Effect.gen(function* () {
    const { lease, state } = yield* makeLeaseFixture()
    yield* lease.activate({ owner: 'ci-123-1', ttlSeconds: 1 })
    state.alarm = null // Consumed before Cloudflare invokes the expiry handler.
    state.now = 2_000
    state.stopFailure = true
    expect((yield* Effect.exit(lease.whileActive(observe, parked)))._tag).toBe('Failure')
    expect(state.stops).toBe(0)
    state.stopFailure = false
    expect(yield* lease.whileActive(observe, parked)).toBe('parked')
    expect(state).toMatchObject({ alarm: null, stops: 1 })
  }),
)

it.effect('bounds activation payloads and leaves production continuously enabled', () =>
  Effect.gen(function* () {
    const { lease, state } = yield* makeLeaseFixture()
    for (const ttlSeconds of [0, 10_801, 2.5]) {
      expect((yield* lease.activate({ owner: 'test', ttlSeconds })).status).toBe(422)
    }
    expect((yield* lease.activate({ owner: ' invalid ', ttlSeconds: 100 })).status).toBe(422)
    expect(state.alarm).toBeNull()

    const production = yield* makeLeaseFixture('production')
    expect((yield* production.lease.activate({ owner: 'test', ttlSeconds: 100 })).status).toBe(403)
    expect((yield* production.lease.park({ owner: 'test' })).status).toBe(403)
    expect(yield* production.lease.whileActive(observe, parked)).toBeUndefined()
    expect(production.state).toMatchObject({ alarm: null, stops: 0 })
  }),
)
