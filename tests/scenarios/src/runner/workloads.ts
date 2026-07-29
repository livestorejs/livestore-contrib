export const prepareWorkloadExpansions = (args: {
  scenario: ScenarioAst
  workloads: ApplicationWorkloadLibrary
}): Effect.Effect<PreparedWorkloadExpansions, ScenarioOperationError> =>
  Effect.gen(function* () {
    const expansions = new Map<string, PreparedWorkloadExpansion>()
    const planOperationIds = new Set(
      args.scenario.phases.flatMap((phase) =>
        phase.steps.flatMap((step) =>
          step._tag === 'parallel' ? [step.id, ...step.operations.map((operation) => operation.id)] : [step.id],
        ),
      ),
    )

    for (const phase of args.scenario.phases) {
      for (const step of phase.steps) {
        if (step._tag !== 'workload') continue
        const workload = args.workloads[step.workload]
        if (workload === undefined) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'unknown-workload',
              `Application ${args.scenario.applicationId} has no workload named ${step.workload}`,
            ),
          )
        }
        const seed = deriveWorkloadSeed({ scenarioSeed: args.scenario.seed, phaseId: phase.id, step })
        const generated = yield* workload.expand({
          input: step.input,
          targets: step.targets,
          count: step.count,
          seed,
        })
        const allowedTargets = new Set(step.targets.map(participantKey))
        const actions = generated.map(
          (action, iteration): PreparedWorkloadAction => ({
            ...action,
            id: `${step.id}:${String(iteration + 1).padStart(4, '0')}`,
          }),
        )
        for (const action of actions) {
          if (allowedTargets.has(participantKey(action.target)) === false) {
            return yield* Effect.fail(
              new ScenarioOperationError(
                'invalid-workload-output',
                `Workload ${step.id} emitted undeclared target ${participantKey(action.target)}`,
              ),
            )
          }
          if (planOperationIds.has(action.id) === true) {
            return yield* Effect.fail(
              new ScenarioOperationError(
                'invalid-workload-output',
                `Workload ${step.id} generated an operation id that collides with the plan: ${action.id}`,
              ),
            )
          }
          planOperationIds.add(action.id)
        }
        expansions.set(step.id, { seed, actions })
      }
    }
    return expansions
  })

const deriveWorkloadSeed = (args: { scenarioSeed: number; phaseId: string; step: WorkloadStep }): number => {
  const input = `${args.scenarioSeed}\u0000${args.phaseId}\u0000${args.step.id}\u0000${args.step.workload}`
  let hash = 2166136261
  for (const character of input) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return hash >>> 0
}
import { Effect } from '@livestore/utils/effect'

import { type ApplicationWorkloadLibrary, ScenarioOperationError } from '../application.ts'
import { participantKey, type ScenarioAst, type WorkloadStep } from '../model.ts'
import type {
  PreparedWorkloadAction,
  PreparedWorkloadExpansion,
  PreparedWorkloadExpansions,
} from './execution.ts'
