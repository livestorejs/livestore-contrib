import type { LiveStoreSchema } from '@livestore/common/schema'
import type { Store } from '@livestore/livestore'
import { Effect, Schema } from '@livestore/utils/effect'

import type { ParticipantRef } from './model.ts'

export class ScenarioOperationError extends Error {
  readonly _tag = 'ScenarioOperationError'

  constructor(
    readonly code:
      | 'application-mismatch'
      | 'capability-unavailable'
      | 'duplicate-client'
      | 'invalid-action-input'
      | 'invalid-inspector-output'
      | 'missing-client'
      | 'missing-participant'
      | 'settlement-timeout'
      | 'unknown-action'
      | 'unknown-inspector',
    message: string,
  ) {
    super(message)
    this.name = 'ScenarioOperationError'
  }
}

export interface ApplicationAction<TSchema extends LiveStoreSchema> {
  readonly dispatch: (store: Store<TSchema>, input: Schema.Json) => Effect.Effect<void, ScenarioOperationError>
}

export interface ApplicationInspector<TSchema extends LiveStoreSchema> {
  readonly inspect: (store: Store<TSchema>) => Effect.Effect<Schema.Json, ScenarioOperationError>
}

export interface ApplicationDefinition<TSchema extends LiveStoreSchema> {
  readonly id: string
  readonly schema: TSchema
  readonly actions: Readonly<Record<string, ApplicationAction<TSchema>>>
  readonly inspectors: Readonly<Record<string, ApplicationInspector<TSchema>>>
}

export const defineApplication = <TSchema extends LiveStoreSchema>(
  definition: ApplicationDefinition<TSchema>,
): ApplicationDefinition<TSchema> => definition

/** Binds schema decoding to an action before it crosses the participant-host boundary. */
export const defineAction = <
  TSchema extends LiveStoreSchema,
  TInputSchema extends Schema.Codec<unknown, unknown, never, never>,
>(args: {
  input: TInputSchema
  run: (args: { store: Store<TSchema>; input: TInputSchema['Type'] }) => Effect.Effect<void, never>
}): ApplicationAction<TSchema> => ({
  dispatch: (store, encodedInput) =>
    Schema.decodeUnknownEffect(args.input)(encodedInput).pipe(
      Effect.mapError(
        (cause) =>
          new ScenarioOperationError('invalid-action-input', `Action input failed schema validation: ${String(cause)}`),
      ),
      Effect.flatMap((input) => args.run({ store, input })),
    ),
})

/** Encodes inspector output as JSON so a host never leaks its Store or SQLite values. */
export const defineInspector = <
  TSchema extends LiveStoreSchema,
  TOutputSchema extends Schema.Codec<unknown, unknown, never, never>,
>(args: {
  output: TOutputSchema
  read: (args: { store: Store<TSchema> }) => TOutputSchema['Type']
}): ApplicationInspector<TSchema> => ({
  inspect: (store) =>
    Schema.encodeUnknownEffect(args.output)(args.read({ store })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      Effect.mapError(
        (cause) =>
          new ScenarioOperationError(
            'invalid-inspector-output',
            `State inspector output failed schema validation: ${String(cause)}`,
          ),
      ),
    ),
})

export const dispatchApplicationAction = <TSchema extends LiveStoreSchema>(args: {
  application: ApplicationDefinition<TSchema>
  store: Store<TSchema>
  participant: ParticipantRef
  action: string
  input: Schema.Json
}): Effect.Effect<void, ScenarioOperationError> => {
  const action = args.application.actions[args.action]
  if (action === undefined) {
    return Effect.fail(
      new ScenarioOperationError(
        'unknown-action',
        `Application ${args.application.id} has no action named ${args.action} for ${args.participant.clientId}/${args.participant.sessionId}`,
      ),
    )
  }
  return action.dispatch(args.store, args.input)
}

export const inspectApplicationState = <TSchema extends LiveStoreSchema>(args: {
  application: ApplicationDefinition<TSchema>
  store: Store<TSchema>
  participant: ParticipantRef
  inspector: string
}): Effect.Effect<Schema.Json, ScenarioOperationError> => {
  const inspector = args.application.inspectors[args.inspector]
  if (inspector === undefined) {
    return Effect.fail(
      new ScenarioOperationError(
        'unknown-inspector',
        `Application ${args.application.id} has no inspector named ${args.inspector} for ${args.participant.clientId}/${args.participant.sessionId}`,
      ),
    )
  }
  return inspector.inspect(args.store)
}
