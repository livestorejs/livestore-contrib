import { Schema } from '@livestore/utils/effect'

import type { ParticipantRef } from '../model.ts'

export interface ScenarioHelperRandom {
  /** Returns a stable value in [0, 1) for this iteration and key. */
  readonly next: (key: string) => number
  readonly integer: (key: string, maximumExclusive: number) => number
  readonly pick: <T>(key: string, values: ReadonlyArray<T>) => T
}

export interface ScenarioHelperRandomSource {
  /** Iterations are authored as positive, one-based numbers. */
  readonly iteration: (iteration: number) => ScenarioHelperRandom
}

export interface GeneratedScenarioAction {
  readonly target: ParticipantRef
  readonly action: string
  readonly input: Schema.Json
}

/** A helper instruction uses the same declarative shape as one YAML `do` entry. */
export type ScenarioHelperInstruction = Readonly<Record<string, unknown>>

export type ScenarioHelperExpansion =
  | {
      readonly _tag: 'actions'
      readonly actions: ReadonlyArray<GeneratedScenarioAction>
      readonly description?: string
    }
  | {
      readonly _tag: 'instructions'
      readonly instructions: ReadonlyArray<ScenarioHelperInstruction>
    }

export interface ScenarioHelperContext {
  readonly random: ScenarioHelperRandomSource
  readonly participant: (reference: string) => ParticipantRef
  readonly participants: (selection: string | ReadonlyArray<string>) => ReadonlyArray<ParticipantRef>
}

export interface RegisteredScenarioHelper {
  readonly expand: (input: Schema.Json, context: ScenarioHelperContext) => ScenarioHelperExpansion
}

export type ScenarioHelperRegistry = Readonly<Record<string, RegisteredScenarioHelper>>

export const helperActions = (
  actions: ReadonlyArray<GeneratedScenarioAction>,
  options: { readonly description?: string } = {},
): ScenarioHelperExpansion => ({ _tag: 'actions', actions, ...options })

export const helperInstructions = (
  instructions: ReadonlyArray<ScenarioHelperInstruction>,
): ScenarioHelperExpansion => ({ _tag: 'instructions', instructions })

/** Registers typed, trusted authoring code that expands before Scenario execution. */
export const defineScenarioHelper = <TInputSchema extends Schema.Codec<unknown, unknown, never, never>>(args: {
  readonly input: TInputSchema
  readonly generate: (args: {
    readonly input: TInputSchema['Type']
    readonly context: ScenarioHelperContext
  }) => ScenarioHelperExpansion
}): RegisteredScenarioHelper => ({
  expand: (input, context) => args.generate({ input: Schema.decodeUnknownSync(args.input)(input), context }),
})

export const defineScenarioHelpers = <const THelpers extends ScenarioHelperRegistry>(helpers: THelpers): THelpers =>
  helpers

export class ScenarioHelperRegistryError extends Error {
  readonly _tag = 'ScenarioHelperRegistryError'

  constructor(message: string) {
    super(message)
    this.name = 'ScenarioHelperRegistryError'
  }
}

const helperName = /^[A-Za-z][A-Za-z0-9_-]*$/

export const composeScenarioHelpers = (
  sources: ReadonlyArray<{ readonly source: string; readonly helpers: ScenarioHelperRegistry | undefined }>,
): ScenarioHelperRegistry => {
  const helpers: Record<string, RegisteredScenarioHelper> = {}
  const origins = new Map<string, string>()
  for (const source of sources) {
    if (source.helpers === undefined) continue
    for (const [name, helper] of Object.entries(source.helpers)) {
      if (helperName.test(name) === false) {
        throw new ScenarioHelperRegistryError(`Invalid Scenario helper name '${name}' from ${source.source}`)
      }
      if (typeof helper !== 'object' || helper === null || typeof helper.expand !== 'function') {
        throw new ScenarioHelperRegistryError(`Invalid Scenario helper '${name}' from ${source.source}`)
      }
      const existing = origins.get(name)
      if (existing !== undefined) {
        throw new ScenarioHelperRegistryError(
          `Duplicate Scenario helper '${name}' from ${existing} and ${source.source}; helpers never override one another`,
        )
      }
      helpers[name] = helper
      origins.set(name, source.source)
    }
  }
  return helpers
}
