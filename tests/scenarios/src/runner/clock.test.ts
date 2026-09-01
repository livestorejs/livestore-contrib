import { describe, expect, it } from '@effect/vitest'

import { Effect, Fiber, TestClock } from '@livestore/utils/effect'

import { waitAtLeast } from './clock.ts'

describe('Scenario controller clock', () => {
  it.effect('measures waits through the contextual Effect Clock', () =>
    Effect.gen(function* () {
      const wait = yield* waitAtLeast(1_000).pipe(Effect.forkChild)
      yield* TestClock.adjust(1_000)
      expect(yield* Fiber.join(wait)).toBe(1_000)
    }),
  )
})
