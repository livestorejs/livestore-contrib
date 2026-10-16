import { describe, expect, it } from '@effect/vitest'

import { Effect, Fiber, TestClock } from '@livestore/utils/effect'

import { waitAtLeast, waitUntilSettled } from './clock.ts'

describe('Scenario controller clock', () => {
  it.effect('measures waits through the contextual Effect Clock', () =>
    Effect.gen(function* () {
      const wait = yield* waitAtLeast(1_000).pipe(Effect.forkChild)
      yield* TestClock.adjust(1_000)
      expect(yield* Fiber.join(wait)).toBe(1_000)
    }),
  )

  it.effect('ends an untilSettled wait after two consecutive settled probes', () =>
    Effect.gen(function* () {
      const answers = [false, true, false, true, true]
      let probes = 0
      const probe = Effect.sync(() => answers[probes++] ?? true)
      const wait = yield* waitUntilSettled(probe, 10_000).pipe(Effect.forkChild)
      yield* TestClock.adjust(1_000)
      expect(yield* Fiber.join(wait)).toEqual({ elapsedMs: 1_000, settled: true })
      expect(probes).toBe(5)
    }),
  )

  it.effect('stops at the upper bound when the system never settles', () =>
    Effect.gen(function* () {
      const wait = yield* waitUntilSettled(Effect.succeed(false), 600).pipe(Effect.forkChild)
      yield* TestClock.adjust(1_000)
      expect(yield* Fiber.join(wait)).toEqual({ elapsedMs: 600, settled: false })
    }),
  )
})
