import type { LiveStoreSchema } from '@livestore/common/schema'
import type { WranglerDevServer } from '@livestore/utils-dev/wrangler'
import { Effect, FetchHttpClient, Layer, type OtelTracer, type Scope } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import type { ApplicationDefinition, ApplicationWorkloadLibrary } from './application/definition.ts'
import {
  type CloudSyncCfScenarioBackendOptions,
  makeCloudSyncCfScenarioBackend,
  makeLocalSyncCfScenarioBackend,
  makeMockScenarioBackend,
} from './backends.ts'
import {
  type ExecutionConfiguration,
  type ScenarioAst,
  type ScenarioRunArtifact,
  type ScenarioTraceRecord,
} from './model.ts'
import { makeBrowserHost } from './profiles/browser/host.ts'
import type { HostError, ParticipantHost } from './profiles/contract.ts'
import { makeInProcessHost } from './profiles/in-process/host.ts'
import { makeProcessHost } from './profiles/process/host.ts'
import { executeClientCreation, executeParallelStep, executeStep } from './runner/execution.ts'
import { makeFaultState, recordOperationFailure } from './runner/faults.ts'
import { captureSnapshots, recordSystemObservation } from './runner/observations.ts'
import { evaluateOracles } from './runner/oracles.ts'
import { describeHostError, makeScenarioArtifact, validateExecution } from './runner/support.ts'
import { makeTraceRecorder } from './runner/trace-recorder.ts'
import { prepareWorkloadExpansions } from './runner/workloads.ts'

export interface RunScenarioOptions {
  readonly runId?: string
  readonly sourceRevision?: string
  readonly execution?: ExecutionConfiguration
  readonly onProgress?: (progress: ScenarioRunProgress) => void
}

export interface ScenarioRunProgress {
  readonly stage: 'started' | 'completed'
  readonly phaseId: string
  readonly stepId: string
  readonly stepNumber: number
  readonly totalSteps: number
}

export const defaultInProcessExecution: ExecutionConfiguration = {
  participantProfile: 'in-process',
  syncBackend: 'mock',
  stateProfile: 'sqlite',
}

export const runInProcessScenario = <TSchema extends LiveStoreSchema>(args: {
  scenario: ScenarioAst
  application: ApplicationDefinition<TSchema>
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const backend = yield* makeMockScenarioBackend
    const host = yield* makeInProcessHost({ application: args.application, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.application.id,
      host,
      workloads: args.application.workloads,
      options: { ...args.options, execution: args.options?.execution ?? defaultInProcessExecution },
    })
  })

export const runInProcessLocalSyncCfScenario = <TSchema extends LiveStoreSchema>(args: {
  scenario: ScenarioAst
  application: ApplicationDefinition<TSchema>
  options?: RunScenarioOptions
}): Effect.Effect<
  ScenarioRunArtifact,
  HostError | WranglerDevServer.WranglerDevServerError,
  Scope.Scope | OtelTracer.OtelTracer
> =>
  Effect.gen(function* () {
    const backend = yield* makeLocalSyncCfScenarioBackend.pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeInProcessHost({ application: args.application, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.application.id,
      host,
      workloads: args.application.workloads,
      options: {
        ...args.options,
        execution: {
          participantProfile: 'in-process',
          syncBackend: 'local-sync-cf',
          stateProfile: 'sqlite',
        },
      },
    })
  })

export const runProcessLocalSyncCfScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  workloads?: ApplicationWorkloadLibrary
  options?: RunScenarioOptions
}): Effect.Effect<
  ScenarioRunArtifact,
  HostError | WranglerDevServer.WranglerDevServerError,
  Scope.Scope | OtelTracer.OtelTracer
> =>
  Effect.gen(function* () {
    const backend = yield* makeLocalSyncCfScenarioBackend.pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeProcessHost({ applicationId: args.applicationId, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.applicationId,
      host,
      workloads: args.workloads,
      options: {
        ...args.options,
        execution: {
          participantProfile: 'process',
          syncBackend: 'local-sync-cf',
          stateProfile: 'sqlite',
        },
      },
    })
  })

export const runBrowserLocalSyncCfScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  workloads?: ApplicationWorkloadLibrary
  options?: RunScenarioOptions
}): Effect.Effect<
  ScenarioRunArtifact,
  HostError | WranglerDevServer.WranglerDevServerError,
  Scope.Scope | OtelTracer.OtelTracer
> =>
  Effect.gen(function* () {
    const backend = yield* makeLocalSyncCfScenarioBackend.pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeBrowserHost({ applicationId: args.applicationId, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.applicationId,
      host,
      workloads: args.workloads,
      options: {
        ...args.options,
        execution: {
          participantProfile: 'browser',
          syncBackend: 'local-sync-cf',
          stateProfile: 'opfs',
        },
      },
    })
  })

export const runInProcessCloudSyncCfScenario = <TSchema extends LiveStoreSchema>(args: {
  scenario: ScenarioAst
  application: ApplicationDefinition<TSchema>
  cloud: CloudSyncCfScenarioBackendOptions
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const backend = yield* makeCloudSyncCfScenarioBackend(args.cloud).pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeInProcessHost({ application: args.application, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.application.id,
      host,
      workloads: args.application.workloads,
      options: {
        ...args.options,
        execution: { participantProfile: 'in-process', syncBackend: 'cloud-sync-cf', stateProfile: 'sqlite' },
      },
    })
  })

export const runProcessCloudSyncCfScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  workloads?: ApplicationWorkloadLibrary
  cloud: CloudSyncCfScenarioBackendOptions
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const backend = yield* makeCloudSyncCfScenarioBackend(args.cloud).pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeProcessHost({ applicationId: args.applicationId, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.applicationId,
      host,
      workloads: args.workloads,
      options: {
        ...args.options,
        execution: { participantProfile: 'process', syncBackend: 'cloud-sync-cf', stateProfile: 'sqlite' },
      },
    })
  })

export const runBrowserCloudSyncCfScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  workloads?: ApplicationWorkloadLibrary
  cloud: CloudSyncCfScenarioBackendOptions
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const backend = yield* makeCloudSyncCfScenarioBackend(args.cloud).pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeBrowserHost({ applicationId: args.applicationId, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.applicationId,
      host,
      workloads: args.workloads,
      options: {
        ...args.options,
        execution: { participantProfile: 'browser', syncBackend: 'cloud-sync-cf', stateProfile: 'opfs' },
      },
    })
  })

/** Executes only against the transport-neutral host surface and emits the portable artifact. */
export const runScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  host: ParticipantHost
  workloads?: ApplicationWorkloadLibrary
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const execution = args.options?.execution ?? defaultInProcessExecution
    yield* validateExecution({ ...args, execution })
    const workloadExpansions = yield* prepareWorkloadExpansions({
      scenario: args.scenario,
      workloads: args.workloads ?? {},
    })

    const runId = args.options?.runId ?? `${args.scenario.id}:${args.scenario.seed}:${Date.now()}`
    const trace: ScenarioTraceRecord[] = []
    let logicalTime = 0
    let activePhaseId: string | undefined
    let activeStepId: string | undefined
    let activeOperationId: string | undefined
    const faultState = makeFaultState()
    const record = makeTraceRecorder({ runId, trace, readLogicalTime: () => logicalTime })

    const executionEffect = Effect.gen(function* () {
      record({
        origin: 'observation',
        payload: {
          _tag: 'run.started',
          scenarioId: args.scenario.id,
          applicationId: args.applicationId,
          seed: args.scenario.seed,
        },
      })
      yield* recordSystemObservation({ host: args.host, record, reason: 'run-started', faultState })

      for (const client of args.scenario.topology.clients) {
        const operationId = `create:${client.id}`
        activeOperationId = operationId
        yield* executeClientCreation({
          host: args.host,
          record,
          operationId,
          storeId: args.scenario.topology.storeId,
          client,
        })
        activeOperationId = undefined
        yield* recordSystemObservation({
          host: args.host,
          record,
          reason: operationId,
          correlationId: operationId,
          faultState,
        })
      }

      const totalSteps = args.scenario.phases.reduce((total, phase) => total + phase.steps.length, 0)
      let stepNumber = 0
      for (const phase of args.scenario.phases) {
        activePhaseId = phase.id
        logicalTime += 1
        record({
          origin: 'observation',
          phaseId: phase.id,
          payload: { _tag: 'phase.started', description: phase.description },
        })
        for (const step of phase.steps) {
          activeStepId = step.id
          activeOperationId = step._tag === 'parallel' ? undefined : step.id
          stepNumber += 1
          args.options?.onProgress?.({ stage: 'started', phaseId: phase.id, stepId: step.id, stepNumber, totalSteps })
          logicalTime += 1
          if (step._tag === 'parallel') {
            yield* executeParallelStep({
              host: args.host,
              storeId: args.scenario.topology.storeId,
              phaseId: phase.id,
              record,
              operations: step.operations,
              workloadExpansions,
              faultState,
              onFailure: (operationId) => {
                activeStepId = operationId
              },
            })
          } else {
            yield* executeStep({
              host: args.host,
              storeId: args.scenario.topology.storeId,
              phaseId: phase.id,
              record,
              step,
              workloadExpansions,
              faultState,
            })
          }
          activeOperationId = undefined
          yield* recordSystemObservation({
            host: args.host,
            record,
            reason: step.id,
            correlationId: step.id,
            phaseId: phase.id,
            faultState,
          })
          args.options?.onProgress?.({ stage: 'completed', phaseId: phase.id, stepId: step.id, stepNumber, totalSteps })
          activeStepId = undefined
        }
        record({ origin: 'observation', phaseId: phase.id, payload: { _tag: 'phase.completed' } })
        activePhaseId = undefined
      }

      const snapshotResult = yield* captureSnapshots({ host: args.host, scenario: args.scenario, record })
      const verdicts = evaluateOracles({
        oracles: args.scenario.oracles,
        snapshots: snapshotResult.snapshots,
        evidenceByParticipant: snapshotResult.evidenceByParticipant,
        trace,
        record,
      })
      const status = verdicts.every((verdict) => verdict.status === 'passed') === true ? 'passed' : 'failed'

      record({ origin: 'observation', payload: { _tag: 'run.completed', status } })

      return yield* makeScenarioArtifact({
        args,
        execution,
        runId,
        trace,
        verdicts,
        snapshots: snapshotResult.snapshots,
        status,
      })
    })

    return yield* executionEffect.pipe(
      Effect.catch((error) => {
        const failure = describeHostError(error)
        if (activeOperationId !== undefined) {
          recordOperationFailure({ record, operationId: activeOperationId, phaseId: activePhaseId, error })
        }
        record({
          origin: 'observation',
          correlationId: activeStepId,
          phaseId: activePhaseId,
          payload: {
            _tag: 'run.failed',
            ...failure,
            phaseId: activePhaseId ?? null,
            stepId: activeStepId ?? null,
          },
        })
        return makeScenarioArtifact({
          args,
          execution,
          runId,
          trace,
          verdicts: [],
          snapshots: [],
          status: 'failed',
        })
      }),
    )
  })
