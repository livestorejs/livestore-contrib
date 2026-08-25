import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'

import { makeSupervisorGate } from './loop-gate.ts'

it.effect('the supervision gate admits exactly one claimant among concurrent ticks', () =>
  Effect.gen(function* () {
    const gate = yield* makeSupervisorGate

    // Two overlapping tick paths race tryBegin: exactly one may fork the
    // loop (regression for the TOCTOU where both observed a stale flag).
    const claims = yield* Effect.all([gate.tryBegin, gate.tryBegin], { discard: false })
    expect(claims.filter((claimed) => claimed === true)).toHaveLength(1)

    // After the loop's ensuring releases the slot, the next tick can claim.
    yield* gate.end
    expect(yield* gate.tryBegin).toBe(true)
  }))
