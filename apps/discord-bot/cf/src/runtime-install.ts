import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'

export interface SerializedRuntime<TRuntime> {
  /** Installs the lazy runtime at most once and returns the installed value. */
  readonly get: Effect.Effect<TRuntime>
  /** Synchronous observation for control-plane summaries only. */
  readonly peek: () => TRuntime | undefined
  /** Runs a short lifecycle-critical action while replacement is excluded. */
  readonly withCurrent: <TValue, TError, TRequirements>(
    use: (runtime: TRuntime) => Effect.Effect<TValue, TError, TRequirements>,
  ) => Effect.Effect<TValue, TError, TRequirements>
  /** Activates the candidate, stops the current owner, then publishes it. */
  readonly replace: (
    candidate: TRuntime,
    /** Must be an infallible stop/handoff after activation ownership succeeds. */
    beforeReplace: (current: TRuntime | undefined) => Effect.Effect<void>,
  ) => Effect.Effect<void>
}

/**
 * One mutex owns the complete async install/swap lifecycle. Callers cannot
 * observe or start a candidate until its activation has completed, and a cold
 * tick racing status cannot build two independent supervisors.
 */
export const makeSerializedRuntime = <TRuntime>(
  build: Effect.Effect<TRuntime>,
  activate: (runtime: TRuntime) => Effect.Effect<void>,
): Effect.Effect<SerializedRuntime<TRuntime>> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    let current: TRuntime | undefined

    const getUnlocked = Effect.suspend(() => {
      if (current !== undefined) return Effect.succeed(current)
      return Effect.flatMap(build, (candidate) =>
        Effect.as(
          activate(candidate).pipe(Effect.tap(() => Effect.sync(() => {
            current = candidate
          }))),
          candidate,
        ))
    })

    const get = Semaphore.withPermits(lock, 1)(getUnlocked)

    const withCurrent: SerializedRuntime<TRuntime>['withCurrent'] = (use) =>
      Semaphore.withPermits(lock, 1)(Effect.flatMap(getUnlocked, use))

    const replace: SerializedRuntime<TRuntime>['replace'] = (candidate, beforeReplace) =>
      Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          // Claiming telemetry ownership is the only fallible handoff step.
          // Do it before stopping the old owner: foreign-event rejection makes
          // late old observations harmless, while failed activation leaves the
          // current runtime and its live fiber untouched.
          yield* activate(candidate)
          yield* beforeReplace(current)
          current = candidate
        }),
      )

    return {
      get,
      peek: () => current,
      withCurrent,
      replace,
    }
  })
