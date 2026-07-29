import { Effect, Scope } from '@livestore/utils/effect'

/** Runs a scoped effect with finalizers owned by a parallel child scope. */
export const withParallelFinalizers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scopedWith((parentScope) =>
    Scope.fork(parentScope, 'parallel').pipe(
      Effect.flatMap((parallelScope) => effect.pipe(Scope.provide(parallelScope))),
    ),
  )
