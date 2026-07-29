import { Deferred, Effect, Fiber } from '@livestore/utils/effect'
import { expect, test } from 'vitest'

import { withParallelFinalizers } from './with-parallel-finalizers.js'

test('starts scoped finalizers in parallel', async () => {
  const finalizersStarted = await Effect.runPromise(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const acquire = (started: Deferred.Deferred<void>) =>
        Effect.acquireRelease(Effect.void, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )

      const fiber = yield* Effect.gen(function* () {
        yield* acquire(firstStarted)
        yield* acquire(secondStarted)
      }).pipe(withParallelFinalizers, Effect.forkChild)

      yield* Effect.all([Deferred.await(firstStarted), Deferred.await(secondStarted)]).pipe(
        Effect.timeout('1 second'),
      )
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)

      return 2
    }),
  )

  expect(finalizersStarted).toBe(2)
})
