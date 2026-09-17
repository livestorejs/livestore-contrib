import { Effect } from '@livestore/utils/effect'

const currentTimeNanos = Effect.clockWith((clock) => clock.currentTimeNanos)

/** Sleeps until at least the requested contextual-clock duration has elapsed. */
export const waitAtLeast = (durationMs: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const startedAt = yield* currentTimeNanos
    const loop: Effect.Effect<number> = Effect.suspend(() =>
      currentTimeNanos.pipe(
        Effect.flatMap((now) => {
          const elapsed = Number(now - startedAt) / 1_000_000
          const remaining = durationMs - elapsed
          return remaining <= 0 ? Effect.succeed(elapsed) : Effect.sleep(remaining).pipe(Effect.andThen(loop))
        }),
      ),
    )
    return yield* loop
  })
