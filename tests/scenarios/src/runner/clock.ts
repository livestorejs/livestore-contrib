import { Effect } from '@livestore/utils/effect'

const currentTimeNanos = Effect.clockWith((clock) => clock.currentTimeNanos)

/** Interval between settlement probes of an `untilSettled` wait. */
const SETTLED_PROBE_INTERVAL_MS = 250

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

/**
 * Polls `probe` until it reports the system settled or `upperBoundMs` elapses. Two consecutive settled probes are
 * required, so a momentary gap between a push and its confirmation does not end the wait.
 */
export const waitUntilSettled = <E, R>(
  probe: Effect.Effect<boolean, E, R>,
  upperBoundMs: number,
): Effect.Effect<{ readonly elapsedMs: number; readonly settled: boolean }, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* currentTimeNanos
    const elapsed = currentTimeNanos.pipe(Effect.map((now) => Number(now - startedAt) / 1_000_000))
    let consecutive = 0
    while (true) {
      consecutive = (yield* probe) === true ? consecutive + 1 : 0
      if (consecutive >= 2) return { elapsedMs: yield* elapsed, settled: true }
      const remaining = upperBoundMs - (yield* elapsed)
      if (remaining <= 0) return { elapsedMs: yield* elapsed, settled: false }
      yield* Effect.sleep(Math.min(SETTLED_PROBE_INTERVAL_MS, remaining))
    }
  })
