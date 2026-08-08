import type { Schema } from '@livestore/utils/effect'

import type { ParticipantRef, ScenarioAst, ScenarioPhase } from './scenario.ts'

const repeatActionsMarker = Symbol('repeat-actions')

export interface ScenarioRandom {
  /** Returns a stable value in [0, 1) for this iteration and key. */
  readonly next: (key: string) => number
  readonly integer: (key: string, maximumExclusive: number) => number
  readonly pick: <T>(key: string, values: ReadonlyArray<T>) => T
}

export interface GeneratedScenarioAction {
  readonly target: ParticipantRef
  readonly action: string
  readonly input: Schema.Json
}

interface RepeatActionsDefinition {
  readonly id: string
  readonly description: string
  readonly count: number
  readonly generate: (args: { readonly iteration: number; readonly random: ScenarioRandom }) => GeneratedScenarioAction
}

export interface RepeatActionsDraft {
  readonly [repeatActionsMarker]: RepeatActionsDefinition
}

type AuthoredScenarioPhase = Omit<ScenarioPhase, 'steps'> & {
  readonly steps: ReadonlyArray<ScenarioPhase['steps'][number] | RepeatActionsDraft>
}

export type AuthoredScenario = Omit<ScenarioAst, 'phases'> & {
  readonly phases: ReadonlyArray<AuthoredScenarioPhase>
}

export interface ScenarioAuthoring {
  /**
   * Keeps repeated activity readable in source while embedding every generated
   * action in the serializable Scenario returned by defineScenario.
   */
  readonly repeatActions: (definition: RepeatActionsDefinition) => RepeatActionsDraft
}

export type ScenarioDefinitionFactory = (authoring: ScenarioAuthoring) => AuthoredScenario

export class ScenarioAuthoringError extends Error {
  readonly _tag = 'ScenarioAuthoringError'

  constructor(message: string) {
    super(message)
    this.name = 'ScenarioAuthoringError'
  }
}

export const scenarioAuthoring: ScenarioAuthoring = {
  repeatActions: (definition) => ({ [repeatActionsMarker]: definition }),
}

/** Expands non-serializable authoring helpers into the portable Scenario AST. */
export const expandScenarioAuthoring = (authored: AuthoredScenario): unknown => ({
  ...authored,
  phases: authored.phases.map((phase) => ({
    ...phase,
    steps: phase.steps.map((step) =>
      isRepeatActionsDraft(step) === true
        ? expandRepeatedActions({
            scenarioSeed: authored.seed,
            phaseId: phase.id,
            definition: step[repeatActionsMarker],
          })
        : step,
    ),
  })),
})

const isRepeatActionsDraft = (input: unknown): input is RepeatActionsDraft =>
  typeof input === 'object' && input !== null && repeatActionsMarker in input

const expandRepeatedActions = (args: {
  readonly scenarioSeed: number
  readonly phaseId: string
  readonly definition: RepeatActionsDefinition
}) => {
  const { definition } = args
  if (Number.isInteger(definition.count) === false || definition.count <= 0 || definition.count > 10_000) {
    throw new ScenarioAuthoringError(`Repeated action count must be between 1 and 10000: ${definition.id}`)
  }
  const seed = hashString(`${args.scenarioSeed}\u0000${args.phaseId}\u0000${definition.id}`)
  return {
    _tag: 'action-sequence' as const,
    id: definition.id,
    description: definition.description,
    seed,
    actions: Array.from({ length: definition.count }, (_, iteration) => ({
      _tag: 'action' as const,
      id: `${definition.id}:${String(iteration + 1).padStart(4, '0')}`,
      ...definition.generate({ iteration, random: makeScenarioRandom(seed, iteration) }),
    })),
  }
}

const makeScenarioRandom = (seed: number, iteration: number): ScenarioRandom => {
  const next = (key: string): number => hashString(`${seed}\u0000${iteration}\u0000${key}`) / 4_294_967_296
  return {
    next,
    integer: (key, maximumExclusive) => {
      if (Number.isInteger(maximumExclusive) === false || maximumExclusive <= 0) {
        throw new ScenarioAuthoringError(
          `Scenario random integer bound must be a positive integer: ${maximumExclusive}`,
        )
      }
      return Math.floor(next(key) * maximumExclusive)
    },
    pick: <T>(key: string, values: ReadonlyArray<T>): T => {
      if (values.length === 0) throw new ScenarioAuthoringError(`Scenario random choice '${key}' requires a value`)
      return values[Math.floor(next(key) * values.length)]!
    },
  }
}

const hashString = (input: string): number => {
  let hash = 2_166_136_261
  for (const character of input) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619)
  return hash >>> 0
}
