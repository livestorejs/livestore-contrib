import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'

import { makeFakeDoStorage } from './fake-do-storage.ts'
import { makeCrypto } from './crypto.ts'
import { keyValueStoreFromDurableStorage } from './storage.ts'
import { makeKeyValueDocsStateStore } from './docs-state.ts'

// The schema pins correlation/principal to exactly 64 lowercase hex chars.
const hex = (suffix: number) => suffix.toString(16).padStart(64, '0')

const provenance = (atMillis: number) => ({
  correlation: hex(atMillis),
  atMillis,
  corpusDigest: 'digest',
  engineConfiguration: 'engine',
  sourceCount: 2,
  inputTokens: 10,
  outputTokens: 20,
  estimatedCostUsdMicros: 30,
})

const quota = (atMillis: number) => ({
  atMillis,
  principal: hex(atMillis),
  inputTokens: 11,
  outputTokens: 22,
  costUsdMicros: 33,
})

it.effect('records, prunes after the rolling window, and sums monthly spend', () =>
  Effect.gen(function* () {
    const store = makeKeyValueDocsStateStore(keyValueStoreFromDurableStorage(makeFakeDoStorage()), makeCrypto())

    yield* store.record({ provenance: provenance(1_000), quota: quota(1_000) })
    yield* store.record({
      provenance: provenance(25 * 60 * 60 * 1_000),
      quota: quota(25 * 60 * 60 * 1_000),
    })

    // Only the fresh sample survives the 24h prune window.
    expect((yield* store.recent(26 * 60 * 60 * 1_000)).provenance).toHaveLength(1)

    expect(yield* store.monthlySpent(new Date('2026-08-03T00:00:00Z').getTime())).toBe(0)
  }))

it.effect('reserveMonthly denies past the ceiling and settles charged reservations', () =>
  Effect.gen(function* () {
    const atMillis = new Date('2026-08-15T12:00:00Z').getTime()
    const store = makeKeyValueDocsStateStore(keyValueStoreFromDurableStorage(makeFakeDoStorage()), makeCrypto())

    const reserved = yield* store.reserveMonthly({ atMillis, costUsdMicros: 500, ceilingUsdMicros: 1_000 })
    expect(reserved._tag).toBe('Reserved')
    expect(yield* store.monthlySpent(atMillis + 1)).toBe(500)

    if (reserved._tag !== 'Reserved') return
    yield* store.settleMonthly({ id: reserved.id, outcome: 'charge', costUsdMicros: 400 })
    expect(yield* store.monthlySpent(atMillis + 1)).toBe(400)

    const denied = yield* store.reserveMonthly({ atMillis, costUsdMicros: 700, ceilingUsdMicros: 1_000 })
    expect(denied._tag).toBe('Denied')
  }))
