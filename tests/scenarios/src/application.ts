import type { LiveStoreSchema } from '@livestore/common/schema'
import type { Store } from '@livestore/livestore'
import { Effect, Schema } from '@livestore/utils/effect'

import { ParticipantRef as ParticipantRefSchema, type ParticipantRef } from './model.ts'

export type ScenarioOperationFailureOutcome = 'definite-failure' | 'indefinite'

export type ParticipantHostFailureCode =
  | 'host-infrastructure-failure'
  | 'host-request-rejected'
  | 'host-response-invalid'
  | 'host-response-timeout'
  | 'host-transport-failure'

export class ScenarioOperationError extends Error {
  readonly _tag = 'ScenarioOperationError'

  constructor(
    readonly code:
      | 'application-mismatch'
      | 'capability-unavailable'
      | 'duplicate-client'
      | ParticipantHostFailureCode
      | 'invalid-action-input'
      | 'invalid-inspector-output'
      | 'invalid-observation-evidence'
      | 'invalid-scenario'
      | 'invalid-workload-input'
      | 'invalid-workload-output'
      | 'missing-client'
      | 'missing-participant'
      | 'operations-in-flight'
      | 'participant-runtime-failure'
      | 'settlement-timeout'
      | 'unknown-action'
      | 'unknown-inspector'
      | 'unknown-workload'
      | 'workload-expansion-failure',
    message: string,
    /** Whether the controller knows that request handling failed or lost the response boundary. */
    readonly operationOutcome: ScenarioOperationFailureOutcome = 'definite-failure',
  ) {
    super(message)
    this.name = 'ScenarioOperationError'
  }
}

/**
 * Creates a portable participant-host failure without coupling its category to
 * what the controller knows about the Scenario operation's completion.
 */
export const participantHostFailure = (args: {
  code: ParticipantHostFailureCode
  message: string
  operationOutcome: ScenarioOperationFailureOutcome
}): ScenarioOperationError => new ScenarioOperationError(args.code, args.message, args.operationOutcome)

export interface ApplicationAction<TSchema extends LiveStoreSchema> {
  readonly dispatch: (store: Store<TSchema>, input: Schema.Json) => Effect.Effect<void, ScenarioOperationError>
}

export interface ApplicationInspector<TSchema extends LiveStoreSchema> {
  readonly inspect: (store: Store<TSchema>) => Effect.Effect<Schema.Json, ScenarioOperationError>
}

export interface GeneratedWorkloadAction {
  readonly target: ParticipantRef
  readonly action: string
  readonly input: Schema.Json
}

export interface WorkloadRandom {
  readonly next: () => number
  readonly integer: (maximumExclusive: number) => number
  readonly pick: <T>(values: ReadonlyArray<T>) => T
}

export interface ApplicationWorkload {
  readonly expand: (args: {
    input: Schema.Json
    targets: ReadonlyArray<ParticipantRef>
    count: number
    seed: number
  }) => Effect.Effect<ReadonlyArray<GeneratedWorkloadAction>, ScenarioOperationError>
}

export type ApplicationWorkloadLibrary = Readonly<Record<string, ApplicationWorkload>>

export interface ApplicationDefinition<TSchema extends LiveStoreSchema> {
  readonly id: string
  readonly schema: TSchema
  readonly actions: Readonly<Record<string, ApplicationAction<TSchema>>>
  readonly inspectors: Readonly<Record<string, ApplicationInspector<TSchema>>>
  readonly workloads: ApplicationWorkloadLibrary
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

/** Defines a pure, seed-driven workload that emits exactly one action per iteration. */
export const defineWorkload = <TInputSchema extends Schema.Codec<unknown, unknown, never, never>>(args: {
  input: TInputSchema
  generate: (args: {
    input: TInputSchema['Type']
    targets: ReadonlyArray<ParticipantRef>
    iteration: number
    random: WorkloadRandom
  }) => GeneratedWorkloadAction
}): ApplicationWorkload => ({
  expand: ({ input: encodedInput, targets, count, seed }) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(args.input)(encodedInput).pipe(
        Effect.mapError(
          (cause) =>
            new ScenarioOperationError(
              'invalid-workload-input',
              `Workload input failed schema validation: ${String(cause)}`,
            ),
        ),
      )
      const random = makeWorkloadRandom(seed)
      const generated = yield* Effect.try({
        try: () =>
          Array.from({ length: count }, (_, iteration) => args.generate({ input, targets, iteration, random })),
        catch: (cause) =>
          new ScenarioOperationError(
            'workload-expansion-failure',
            `Workload expansion failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      })
      return yield* Schema.decodeUnknownEffect(Schema.Array(GeneratedWorkloadActionSchema))(generated).pipe(
        Effect.mapError(
          (cause) =>
            new ScenarioOperationError(
              'invalid-workload-output',
              `Generated workload action failed serialization validation: ${String(cause)}`,
            ),
        ),
      )
    }),
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

const GeneratedWorkloadActionSchema = Schema.Struct({
  target: ParticipantRefSchema,
  action: Schema.String,
  input: Schema.Json,
})

const makeWorkloadRandom = (seed: number): WorkloadRandom => {
  let state = seed >>> 0
  const next = (): number => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
  return {
    next,
    integer: (maximumExclusive) => {
      if (Number.isInteger(maximumExclusive) === false || maximumExclusive <= 0) {
        throw new Error(`Workload random integer bound must be a positive integer: ${maximumExclusive}`)
      }
      return Math.floor(next() * maximumExclusive)
    },
    pick: <T>(values: ReadonlyArray<T>): T => {
      if (values.length === 0) throw new Error('Workload random choice requires at least one value')
      return values[Math.floor(next() * values.length)]!
    },
  }
}
