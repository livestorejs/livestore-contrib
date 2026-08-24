import { Effect, Schema } from 'effect'

export const DocsProviderReadiness = Schema.Struct({
  projectId: Schema.String,
  model: Schema.String,
  store: Schema.Literal(false),
  admitted: Schema.Boolean,
})
export type DocsProviderReadiness = typeof DocsProviderReadiness.Type

export class DocsProviderReadinessError extends Schema.TaggedError<DocsProviderReadinessError>()(
  'DocsProviderReadinessError',
  { reason: Schema.Literals(['unavailable', 'wrong_project', 'wrong_posture']), message: Schema.String },
) {}

/** Provider boundary used by startup admission and by deterministic tests. */
export interface DocsProviderReadinessPort {
  readonly inspect: Effect.Effect<DocsProviderReadiness, DocsProviderReadinessError>
}

export interface DocsProviderReadinessExpectation {
  readonly projectId: string
  readonly model: string
}

/** Fails closed unless the provider reports the exact project/model/posture. */
export const admitDocsProvider = (port: DocsProviderReadinessPort, expected: DocsProviderReadinessExpectation) =>
  port.inspect.pipe(
    Effect.flatMap((actual) =>
      actual.projectId !== expected.projectId
        ? Effect.fail(
            new DocsProviderReadinessError({
              reason: 'wrong_project',
              message: 'Provider project identity differs from deployment',
            }),
          )
        : actual.model !== expected.model
          ? Effect.fail(
              new DocsProviderReadinessError({
                reason: 'wrong_project',
                message: 'Provider model differs from deployment',
              }),
            )
          : actual.store !== false
            ? Effect.fail(
                new DocsProviderReadinessError({
                  reason: 'wrong_posture',
                  message: 'Provider retention posture is not store:false',
                }),
              )
            : actual.admitted === true
              ? Effect.succeed(actual)
              : Effect.fail(
                  new DocsProviderReadinessError({
                    reason: 'unavailable',
                    message: 'Provider project is not admitted',
                  }),
                ),
    ),
  )
