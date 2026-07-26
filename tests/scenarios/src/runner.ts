import type { LiveStoreSchema } from '@livestore/common/schema'
import { EventSequenceNumber } from '@livestore/common/schema'
import type { WranglerDevServer } from '@livestore/utils-dev/wrangler'
import {
  Deferred,
  Effect,
  Exit,
  FetchHttpClient,
  Layer,
  type OtelTracer,
  Schema,
  type Scope,
} from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import {
  type ApplicationDefinition,
  type ApplicationWorkloadLibrary,
  type GeneratedWorkloadAction,
  ScenarioOperationError,
} from './application.ts'
import { makeLocalSyncCfScenarioBackend, makeMockScenarioBackend } from './backends.ts'
import { makeBrowserHost } from './browser/browser-host.ts'
import { deriveScenarioRequirements, sessionsBeyondHostLimit } from './capabilities.ts'
import { makeInProcessHost, type HostError, type ParticipantHost } from './host.ts'
import {
  type ComponentSyncObservation,
  type ClientDefinition,
  type OracleVerdict,
  type ExecutionConfiguration,
  type HostObservationOccurrence,
  type HostSystemObservation,
  type ObservedEvent,
  type OperationHistoryOracle,
  type ParallelOperationStep,
  type ParticipantRef,
  type ParticipantSnapshot,
  defineScenario,
  deriveScenarioTopology,
  participantKey,
  type ScenarioAst,
  type ScenarioOracle,
  scenarioArtifactVersion,
  ScenarioRunArtifact,
  type ScenarioStep,
  scenarioTraceVersion,
  type ScenarioTracePayload,
  type ScenarioTraceRecord,
  type SyncObservationPayload,
  type SyncObservation,
  type WorkloadStep,
} from './model.ts'
import { makeProcessHost } from './process/process-host.ts'
import { deriveOverlappingScenarioOperationPairs, deriveScenarioOperationHistoryProjection } from './projection.ts'

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

type TraceInput = {
  readonly origin: ScenarioTraceRecord['origin']
  readonly payload: ScenarioTracePayload
  readonly correlationId?: string
  readonly causationId?: string
  readonly clientId?: string
  readonly sessionId?: string
  readonly phaseId?: string
  readonly captureId?: string
  readonly evidence?: ScenarioTraceRecord['evidence']
  readonly causedBy?: ReadonlyArray<number>
  readonly occurrence?: HostObservationOccurrence
}

interface TraceRecorder {
  (input: TraceInput): ScenarioTraceRecord
  readonly nextCaptureId: (reason: string) => string
  readonly instructionIndex: (correlationId: string) => ReadonlyArray<number>
  readonly pendingOperationIds: (excluding?: ReadonlyArray<string>) => ReadonlyArray<string>
}

const makeTraceRecorder = (args: {
  runId: string
  trace: ScenarioTraceRecord[]
  readLogicalTime: () => number
}): TraceRecorder => {
  let index = 0
  let captureIndex = 0
  const startedAt = performance.now()
  const instructionByCorrelation = new Map<string, number>()
  const pendingOperationIds = new Set<string>()
  const record = (input: TraceInput): ScenarioTraceRecord => {
    const coordinatorReceiptMonotonicMs = performance.now() - startedAt
    const occurrence = input.occurrence
    const localMonotonicMs = occurrence?.reading.localMonotonicMs ?? coordinatorReceiptMonotonicMs
    const causedBy =
      input.causedBy ??
      (input.origin === 'acknowledgement' && input.correlationId !== undefined
        ? [instructionByCorrelation.get(input.correlationId)].filter((value): value is number => value !== undefined)
        : [])
    const traceRecord: ScenarioTraceRecord = {
      traceVersion: scenarioTraceVersion,
      runId: args.runId,
      index,
      origin: input.origin,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      clientId: input.clientId ?? null,
      sessionId: input.sessionId ?? null,
      phaseId: input.phaseId ?? null,
      logicalTime: args.readLogicalTime(),
      wallTimeMs: Date.now(),
      captureId: input.captureId ?? null,
      evidence: input.evidence ?? evidenceForOrigin(input.origin),
      emitterId: occurrence?.reading.emitterId ?? 'scenario-controller',
      localSequence: occurrence?.reading.localSequence ?? index,
      localMonotonicMs,
      coordinatorReceiptMonotonicMs,
      calibratedTime:
        occurrence === undefined
          ? {
              earliestMs: coordinatorReceiptMonotonicMs,
              latestMs: coordinatorReceiptMonotonicMs,
              calibrationId: 'scenario-controller-clock',
            }
          : {
              earliestMs: occurrence.controllerBeforeMonotonicMs - startedAt,
              latestMs: occurrence.controllerAfterMonotonicMs - startedAt,
              calibrationId: occurrence.calibrationId,
            },
      causedBy: [...causedBy],
      payload: input.payload,
    }
    if (input.origin === 'instruction' && input.correlationId !== undefined) {
      instructionByCorrelation.set(input.correlationId, index)
      pendingOperationIds.add(input.correlationId)
    } else if (
      input.correlationId !== undefined &&
      (input.origin === 'acknowledgement' || input.payload._tag === 'operation.outcome')
    ) {
      pendingOperationIds.delete(input.correlationId)
    }
    index += 1
    args.trace.push(traceRecord)
    return traceRecord
  }
  return Object.assign(record, {
    nextCaptureId: (reason: string) => `${args.runId}:capture:${captureIndex++}:${reason}`,
    instructionIndex: (correlationId: string) => {
      const instructionIndex = instructionByCorrelation.get(correlationId)
      return instructionIndex === undefined ? [] : [instructionIndex]
    },
    pendingOperationIds: (excluding: ReadonlyArray<string> = []) => {
      const excluded = new Set(excluding)
      return [...pendingOperationIds].filter((operationId) => excluded.has(operationId) === false)
    },
  })
}

const evidenceForOrigin = (origin: ScenarioTraceRecord['origin']): ScenarioTraceRecord['evidence'] => {
  switch (origin) {
    case 'instruction':
      return 'instruction-sent'
    case 'acknowledgement':
      return 'acknowledgement-received'
    case 'verdict':
      return 'verdict'
    case 'observation':
      return 'controller-event'
  }
}

interface PreparedWorkloadAction extends GeneratedWorkloadAction {
  readonly id: string
}

interface PreparedWorkloadExpansion {
  readonly seed: number
  readonly actions: ReadonlyArray<PreparedWorkloadAction>
}

type PreparedWorkloadExpansions = ReadonlyMap<string, PreparedWorkloadExpansion>

const executeParallelStep = (args: {
  host: ParticipantHost
  storeId: string
  phaseId: string
  record: TraceRecorder
  operations: ReadonlyArray<ParallelOperationStep>
  workloadExpansions: PreparedWorkloadExpansions
  faultState: ScenarioFaultState
  onFailure: (operationId: string) => void
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const allInvoked = yield* Deferred.make<void>()
    let invocationCount = 0
    const onInvoked = () =>
      Effect.gen(function* () {
        invocationCount += 1
        if (invocationCount === args.operations.length) yield* Deferred.succeed(allInvoked, undefined)
        yield* Deferred.await(allInvoked)
      })
    const results = yield* Effect.forEach(
      args.operations,
      (operation) =>
        executeStep({ ...args, step: operation, onInvoked }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              recordOperationFailure({
                record: args.record,
                operationId: operation.id,
                phaseId: args.phaseId,
                error,
              }),
            ),
          ),
          Effect.exit,
          Effect.map((exit) => ({ operationId: operation.id, exit })),
        ),
      { concurrency: 'unbounded' },
    )
    const firstFailure = results.find((result) => Exit.isFailure(result.exit))
    if (firstFailure !== undefined && Exit.isFailure(firstFailure.exit) === true) {
      args.onFailure(firstFailure.operationId)
      return yield* Effect.failCause(firstFailure.exit.cause)
    }
  })

const executeStep = (args: {
  host: ParticipantHost
  storeId: string
  phaseId: string
  record: TraceRecorder
  step: Exclude<ScenarioStep, { readonly _tag: 'parallel' }>
  workloadExpansions: PreparedWorkloadExpansions
  faultState: ScenarioFaultState
  onInvoked?: () => Effect.Effect<void>
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> => {
  switch (args.step._tag) {
    case 'create-client':
      return executeClientCreation({
        host: args.host,
        record: args.record,
        operationId: args.step.id,
        storeId: args.storeId,
        client: args.step.client,
        phaseId: args.phaseId,
      })
    case 'add-session': {
      const step = args.step
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload: { _tag: 'lifecycle.session-add.requested' },
        })
        yield* args.host.addSession({ operationId: step.id, target: step.target })
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload: { _tag: 'lifecycle.session-added' },
        })
      })
    }
    case 'action': {
      return executeAction({ ...args, action: args.step }).pipe(Effect.asVoid)
    }
    case 'workload':
      return executeWorkload({
        host: args.host,
        phaseId: args.phaseId,
        record: args.record,
        step: args.step,
        workloadExpansions: args.workloadExpansions,
      })
    case 'disconnect':
    case 'reconnect': {
      const connected = args.step._tag === 'reconnect'
      return setConnectivity({
        host: args.host,
        phaseId: args.phaseId,
        record: args.record,
        clientId: args.step.clientId,
        operationId: args.step.id,
        connected,
        faultState: args.faultState,
        onInvoked: args.onInvoked,
      })
    }
    case 'backend-unavailable':
    case 'backend-available':
      return setBackendAvailability({
        host: args.host,
        phaseId: args.phaseId,
        record: args.record,
        operationId: args.step.id,
        available: args.step._tag === 'backend-available',
        faultState: args.faultState,
        onInvoked: args.onInvoked,
      })
    case 'stop-session':
    case 'restart-session': {
      const step = args.step
      const restarting = step._tag === 'restart-session'
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload:
            restarting === true
              ? { _tag: 'lifecycle.session-restart.requested' }
              : { _tag: 'lifecycle.session-stop.requested' },
        })
        if (args.onInvoked !== undefined) yield* args.onInvoked()
        const command = { operationId: step.id, target: step.target }
        if (restarting === true) yield* args.host.restartSession(command)
        else yield* args.host.stopSession(command)
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload:
            restarting === true ? { _tag: 'lifecycle.session-restarted' } : { _tag: 'lifecycle.session-stopped' },
        })
      })
    }
    case 'restart-client': {
      const step = args.step
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          clientId: step.clientId,
          phaseId: args.phaseId,
          payload: { _tag: 'lifecycle.client-restart.requested' },
        })
        if (args.onInvoked !== undefined) yield* args.onInvoked()
        yield* args.host.restartClient({ operationId: step.id, clientId: step.clientId })
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          clientId: step.clientId,
          phaseId: args.phaseId,
          payload: { _tag: 'lifecycle.client-restarted' },
        })
      })
    }
    case 'settle': {
      const step = args.step
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          phaseId: args.phaseId,
          payload: {
            _tag: 'settlement.requested',
            participants: step.participants.map(participantKey),
            healDisconnectedClients: [...step.healDisconnectedClients],
            timeoutMs: step.timeoutMs,
          },
        })
        for (const clientId of step.healDisconnectedClients) {
          const operationId = `${step.id}:heal:${clientId}`
          yield* setConnectivity({
            host: args.host,
            phaseId: args.phaseId,
            record: args.record,
            clientId,
            operationId,
            connected: true,
            faultState: args.faultState,
          }).pipe(
            Effect.catch((error) => {
              recordOperationFailure({ record: args.record, operationId, phaseId: args.phaseId, error })
              return Effect.fail(error)
            }),
          )
        }
        const inFlightOperationIds = args.record.pendingOperationIds([step.id])
        if (inFlightOperationIds.length > 0) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'operations-in-flight',
              `Settlement ${step.id} cannot establish quiescence with operations in flight: ${inFlightOperationIds.join(', ')}`,
            ),
          )
        }
        args.record({
          origin: 'observation',
          correlationId: step.id,
          phaseId: args.phaseId,
          causedBy: args.record.instructionIndex(step.id),
          payload: { _tag: 'quiescence.reached', inFlightOperationIds },
        })
        const settled = yield* awaitSettlement({
          host: args.host,
          participants: step.participants,
          timeoutMs: step.timeoutMs,
          record: args.record,
          phaseId: args.phaseId,
          correlationId: step.id,
          faultState: args.faultState,
        })
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          phaseId: args.phaseId,
          payload: { _tag: 'settlement.completed', observations: settled.map(syncObservationPayload) },
        })
      })
    }
  }
}

const executeClientCreation = (args: {
  host: ParticipantHost
  record: TraceRecorder
  operationId: string
  storeId: string
  client: ClientDefinition
  phaseId?: string
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    args.record({
      origin: 'instruction',
      correlationId: args.operationId,
      clientId: args.client.id,
      phaseId: args.phaseId,
      payload: {
        _tag: 'client.create.requested',
        sessions: [...args.client.sessions],
        initiallyConnected: args.client.initiallyConnected,
      },
    })
    yield* args.host.createClient({ operationId: args.operationId, storeId: args.storeId, client: args.client })
    args.record({
      origin: 'acknowledgement',
      correlationId: args.operationId,
      clientId: args.client.id,
      phaseId: args.phaseId,
      payload: { _tag: 'client.created', status: 'acknowledged' },
    })
  })

const executeAction = (args: {
  host: ParticipantHost
  phaseId: string
  record: TraceRecorder
  action: PreparedWorkloadAction
  causationId?: string
  causedBy?: ReadonlyArray<number>
  onInvoked?: () => Effect.Effect<void>
}): Effect.Effect<ScenarioTraceRecord, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    args.record({
      origin: 'instruction',
      correlationId: args.action.id,
      causationId: args.causationId,
      causedBy: args.causedBy,
      clientId: args.action.target.clientId,
      sessionId: args.action.target.sessionId,
      phaseId: args.phaseId,
      payload: { _tag: 'action.requested', action: args.action.action, input: args.action.input },
    })
    if (args.onInvoked !== undefined) yield* args.onInvoked()
    yield* args.host.dispatchAction({
      operationId: args.action.id,
      target: args.action.target,
      action: args.action.action,
      input: args.action.input,
    })
    return args.record({
      origin: 'acknowledgement',
      correlationId: args.action.id,
      causationId: args.causationId,
      clientId: args.action.target.clientId,
      sessionId: args.action.target.sessionId,
      phaseId: args.phaseId,
      payload: { _tag: 'action.completed', action: args.action.action, status: 'acknowledged' },
    })
  })

const executeWorkload = (args: {
  host: ParticipantHost
  phaseId: string
  record: TraceRecorder
  step: WorkloadStep
  workloadExpansions: PreparedWorkloadExpansions
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const expansion = args.workloadExpansions.get(args.step.id)
    if (expansion === undefined) {
      return yield* Effect.fail(
        new ScenarioOperationError('invalid-scenario', `Workload ${args.step.id} was not prepared before execution`),
      )
    }
    const instruction = args.record({
      origin: 'instruction',
      correlationId: args.step.id,
      phaseId: args.phaseId,
      payload: {
        _tag: 'workload.requested',
        workload: args.step.workload,
        input: args.step.input,
        targets: args.step.targets.map(participantKey),
        count: args.step.count,
        seed: expansion.seed,
      },
    })
    const acknowledgements: ScenarioTraceRecord[] = []
    for (const action of expansion.actions) {
      const acknowledgement = yield* executeAction({
        host: args.host,
        phaseId: args.phaseId,
        record: args.record,
        action,
        causationId: args.step.id,
        causedBy: [instruction.index],
      }).pipe(
        Effect.catch((error) => {
          recordOperationFailure({ record: args.record, operationId: action.id, phaseId: args.phaseId, error })
          return Effect.fail(error)
        }),
      )
      acknowledgements.push(acknowledgement)
    }
    args.record({
      origin: 'acknowledgement',
      correlationId: args.step.id,
      phaseId: args.phaseId,
      causedBy: [instruction.index, ...acknowledgements.map((record) => record.index)],
      payload: {
        _tag: 'workload.completed',
        workload: args.step.workload,
        actionIds: expansion.actions.map((action) => action.id),
        status: 'acknowledged',
      },
    })
  })

const setConnectivity = (args: {
  host: ParticipantHost
  phaseId: string
  record: TraceRecorder
  clientId: string
  operationId: string
  connected: boolean
  faultState: ScenarioFaultState
  onInvoked?: () => Effect.Effect<void>
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    args.record({
      origin: 'instruction',
      correlationId: args.operationId,
      clientId: args.clientId,
      phaseId: args.phaseId,
      payload:
        args.connected === true
          ? { _tag: 'connectivity.reconnect.requested', connected: true }
          : { _tag: 'connectivity.disconnect.requested', connected: false },
    })
    if (args.onInvoked !== undefined) yield* args.onInvoked()
    yield* args.host.setConnectivity({
      operationId: args.operationId,
      clientId: args.clientId,
      connected: args.connected,
    })
    const acknowledgement = args.record({
      origin: 'acknowledgement',
      correlationId: args.operationId,
      clientId: args.clientId,
      phaseId: args.phaseId,
      payload:
        args.connected === true
          ? { _tag: 'connectivity.reconnected', connected: true }
          : { _tag: 'connectivity.disconnected', connected: false },
    })
    const faultId = args.connected === false ? args.operationId : args.faultState.activeByClient.get(args.clientId)
    if (faultId !== undefined) {
      args.faultState.pendingByClient.set(args.clientId, {
        operationId: args.operationId,
        connected: args.connected,
        faultId,
        acknowledgementRecordIndex: acknowledgement.index,
      })
    }
  })

const setBackendAvailability = (args: {
  host: ParticipantHost
  phaseId: string
  record: TraceRecorder
  operationId: string
  available: boolean
  faultState: ScenarioFaultState
  onInvoked?: () => Effect.Effect<void>
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    args.record({
      origin: 'instruction',
      correlationId: args.operationId,
      phaseId: args.phaseId,
      payload: { _tag: 'backend.availability.requested', available: args.available },
    })
    if (args.onInvoked !== undefined) yield* args.onInvoked()
    yield* args.host.setBackendAvailability({ operationId: args.operationId, available: args.available })
    const acknowledgement = args.record({
      origin: 'acknowledgement',
      correlationId: args.operationId,
      phaseId: args.phaseId,
      payload: { _tag: 'backend.availability.changed', available: args.available },
    })
    const faultId = args.available === false ? args.operationId : args.faultState.backend.active
    if (faultId !== undefined) {
      args.faultState.backend.pending = {
        operationId: args.operationId,
        available: args.available,
        faultId,
        acknowledgementRecordIndex: acknowledgement.index,
      }
    }
  })

/** Records component-scoped facts so every cursor advances one observed component at a time. */
const recordSystemObservation = (args: {
  host: ParticipantHost
  record: TraceRecorder
  reason: string
  correlationId?: string
  phaseId?: string
  observation?: HostSystemObservation
  faultState: ScenarioFaultState
}): Effect.Effect<void, HostError, Scope.Scope> =>
  Effect.gen(function* () {
    const captureId = args.record.nextCaptureId(args.reason)
    const observation = args.observation === undefined ? yield* args.host.observeSystem : args.observation
    const backendRecord = args.record({
      origin: 'observation',
      correlationId: args.correlationId,
      phaseId: args.phaseId,
      captureId,
      evidence: 'first-observed',
      occurrence: observation.occurrences.backend,
      payload: { _tag: 'backend.observed', reason: args.reason, observation: observation.backend },
    })
    recordObservedBackendFaultTransition({
      available: observation.backend.connected,
      backendRecord,
      faultState: args.faultState,
      record: args.record,
      phaseId: args.phaseId,
      captureId,
      occurrence: observation.occurrences.backend,
    })
    for (const client of observation.clients) {
      const clientOccurrences = observation.occurrences.clients.find((item) => item.clientId === client.clientId)
      if (clientOccurrences === undefined) {
        return yield* Effect.fail(
          new ScenarioOperationError(
            'invalid-observation-evidence',
            `System observation omitted timing evidence for Client ${client.clientId}`,
          ),
        )
      }
      const connectivityRecord = args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        clientId: client.clientId,
        phaseId: args.phaseId,
        captureId,
        evidence: 'first-observed',
        occurrence: clientOccurrences.connectivity,
        payload: { _tag: 'client.connectivity.observed', reason: args.reason, connected: client.connected },
      })
      recordObservedFaultTransition({
        clientId: client.clientId,
        connected: client.connected,
        connectivityRecord,
        faultState: args.faultState,
        record: args.record,
        phaseId: args.phaseId,
        captureId,
        occurrence: clientOccurrences.connectivity,
      })
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        clientId: client.clientId,
        phaseId: args.phaseId,
        captureId,
        evidence: 'first-observed',
        occurrence: clientOccurrences.leader,
        payload: { _tag: 'leader.sync.observed', reason: args.reason, observation: client.leader },
      })
      for (const session of client.sessions) {
        const sessionOccurrence = clientOccurrences.sessions.find((item) => item.sessionId === session.sessionId)
        if (sessionOccurrence === undefined) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'invalid-observation-evidence',
              `System observation omitted timing evidence for ${client.clientId}/${session.sessionId}`,
            ),
          )
        }
        args.record({
          origin: 'observation',
          correlationId: args.correlationId,
          clientId: client.clientId,
          sessionId: session.sessionId,
          phaseId: args.phaseId,
          captureId,
          evidence: 'first-observed',
          occurrence: sessionOccurrence.occurrence,
          payload: { _tag: 'session.sync.observed', reason: args.reason, observation: session.sync },
        })
      }
    }

    const runtimeFailures = yield* args.host.drainRuntimeFailures
    for (const failure of runtimeFailures) {
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        clientId: failure.clientId,
        sessionId: failure.sessionId ?? undefined,
        phaseId: args.phaseId,
        captureId,
        evidence: 'first-observed',
        payload: {
          _tag: 'runtime.failure.observed',
          source: failure.source,
          code: failure.code,
          message: failure.message,
        },
      })
    }
    const firstFailure = runtimeFailures[0]
    if (firstFailure !== undefined) {
      return yield* Effect.fail(
        new ScenarioOperationError(
          'participant-runtime-failure',
          `${firstFailure.clientId}/${firstFailure.sessionId ?? 'Leader'} reported ${firstFailure.code}: ${firstFailure.message}`,
        ),
      )
    }
  })

const awaitSettlement = (args: {
  host: ParticipantHost
  participants: ReadonlyArray<ParticipantRef>
  timeoutMs: number
  record: TraceRecorder
  phaseId: string
  correlationId: string
  faultState: ScenarioFaultState
}): Effect.Effect<ReadonlyArray<SyncObservation>, HostError, Scope.Scope> => {
  const deadline = Date.now() + args.timeoutMs
  let lastLoggedSignature: string | undefined
  let lastObservations: ReadonlyArray<SyncObservationPayload> = []

  const loop = (
    previousStableSignature: string | undefined,
  ): Effect.Effect<ReadonlyArray<SyncObservation>, HostError, Scope.Scope> =>
    Effect.gen(function* () {
      // A browser-wide observation can remain busy while a large reconnect is
      // being applied. Let it consume the remaining settlement budget instead
      // of imposing a second, shorter deadline on the same bounded operation.
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return yield* Effect.fail(settlementTimeoutError(args.correlationId, args.timeoutMs, lastObservations))
      }
      const observationTimeoutMs = remainingMs
      const systemObservation = yield* args.host.observeSystem.pipe(
        Effect.timeoutOrElse({
          duration: observationTimeoutMs,
          orElse: () =>
            Effect.fail(
              new ScenarioOperationError(
                'settlement-timeout',
                `Settlement ${args.correlationId} timed out observing the system after ${observationTimeoutMs}ms`,
              ),
            ),
        }),
      )
      const observations = yield* Effect.forEach(args.participants, (participant) =>
        deriveSyncObservation({ observation: systemObservation, participant }),
      )
      const signature = canonicalJson(observations.map(syncObservationPayload))
      const isStable = observationsAreSettled(observations)
      lastObservations = observations.map(syncObservationPayload)
      if (process.env.SCENARIO_PROGRESS === '1' && signature !== lastLoggedSignature) {
        console.log(`  settlement ${args.correlationId}: ${signature}`)
        lastLoggedSignature = signature
      }
      const progress = args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        phaseId: args.phaseId,
        payload: {
          _tag: 'settlement.progress',
          settled: isStable,
          observations: observations.map(syncObservationPayload),
        },
      })
      yield* recordSystemObservation({
        host: args.host,
        record: args.record,
        reason: 'settlement-poll',
        correlationId: args.correlationId,
        phaseId: args.phaseId,
        observation: systemObservation,
        faultState: args.faultState,
      }).pipe(
        Effect.timeoutOrElse({
          duration: observationTimeoutMs,
          orElse: () =>
            Effect.fail(
              new ScenarioOperationError(
                'settlement-timeout',
                `Settlement ${args.correlationId} timed out recording its system observation after ${observationTimeoutMs}ms`,
              ),
            ),
        }),
      )

      const recoveryFaults = selectedRecoveryFaults(args.faultState, args.participants)
      const recoveryObservation =
        recoveryFaults.length === 0
          ? undefined
          : args.record({
              origin: 'observation',
              correlationId: args.correlationId,
              phaseId: args.phaseId,
              causedBy: [...recoveryFaults.map((fault) => fault.removalRecordIndex), progress.index],
              payload: {
                _tag: 'recovery.observed',
                faultIds: recoveryFaults.map((fault) => fault.faultId),
                converged: isStable,
                observations: lastObservations,
              },
            })

      if (isStable === true && previousStableSignature === signature) {
        if (recoveryObservation !== undefined) {
          args.record({
            origin: 'observation',
            correlationId: args.correlationId,
            phaseId: args.phaseId,
            causedBy: [recoveryObservation.index],
            payload: {
              _tag: 'recovery.completed',
              faultIds: recoveryFaults.map((fault) => fault.faultId),
              observations: lastObservations,
            },
          })
          for (const fault of recoveryFaults) {
            if (fault.scope === 'client') args.faultState.recoveringByClient.delete(fault.clientId)
            else args.faultState.backend.recovering = undefined
          }
        }
        return observations
      }
      if (Date.now() >= deadline) {
        return yield* Effect.fail(settlementTimeoutError(args.correlationId, args.timeoutMs, lastObservations))
      }
      // A browser settlement probe crosses every page plus the backend. A
      // moderate cadence leaves room for the sync work being observed.
      yield* Effect.sleep('100 millis')
      return yield* loop(isStable === true ? signature : undefined)
    })

  return Effect.suspend(() => loop(undefined)).pipe(
    Effect.catch((error) => {
      const failure = describeHostError(error)
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        phaseId: args.phaseId,
        payload: {
          _tag: 'settlement.failed',
          ...failure,
          timeoutMs: args.timeoutMs,
          observations: lastObservations,
        },
      })
      return Effect.fail(error)
    }),
  )
}

const deriveSyncObservation = (args: {
  observation: HostSystemObservation
  participant: ParticipantRef
}): Effect.Effect<SyncObservation, ScenarioOperationError> => {
  const client = args.observation.clients.find((candidate) => candidate.clientId === args.participant.clientId)
  const session = client?.sessions.find((candidate) => candidate.sessionId === args.participant.sessionId)
  if (client === undefined || session === undefined) {
    return Effect.fail(
      new ScenarioOperationError(
        'missing-participant',
        `System observation omitted ${participantKey(args.participant)}`,
      ),
    )
  }

  const backendHead = EventSequenceNumber.Client.fromString(args.observation.backend.head)
  const leaderLocalHead = EventSequenceNumber.Client.fromString(client.leader.localHead)
  const leaderUpstreamHead = EventSequenceNumber.Client.fromString(client.leader.upstreamHead)
  const sessionLocalHead = EventSequenceNumber.Client.fromString(session.sync.localHead)
  const sessionUpstreamHead = EventSequenceNumber.Client.fromString(session.sync.upstreamHead)
  const pendingCount = Math.max(
    client.leader.pendingCount,
    session.sync.pendingCount,
    leaderLocalHead.client,
    leaderUpstreamHead.client,
    sessionLocalHead.client,
    sessionUpstreamHead.client,
  )
  const componentHeads = [leaderLocalHead, leaderUpstreamHead, sessionLocalHead, sessionUpstreamHead]
  return Effect.succeed({
    participant: args.participant,
    localHead: session.sync.localHead,
    upstreamHead: args.observation.backend.head,
    pendingCount,
    isSynced:
      args.observation.backend.connected === true &&
      client.connected === true &&
      pendingCount === 0 &&
      componentHeads.every((head) => head.global === backendHead.global),
  })
}

const captureSnapshots = (args: {
  host: ParticipantHost
  scenario: ScenarioAst
  record: TraceRecorder
}): Effect.Effect<
  {
    snapshots: ReadonlyArray<ParticipantSnapshot>
    evidenceByParticipant: ReadonlyMap<string, ReadonlyArray<number>>
  },
  HostError,
  Scope.Scope
> => {
  const inspectorNames = [
    ...new Set(
      args.scenario.oracles.flatMap((oracle) =>
        oracle._tag === 'state-convergence' || oracle._tag === 'state-contains-ids' ? [oracle.inspector] : [],
      ),
    ),
  ]
  const participants = deriveScenarioTopology(args.scenario).flatMap((client) =>
    client.sessions.map((sessionId) => ({ clientId: client.id, sessionId })),
  )

  return Effect.gen(function* () {
    const evidenceByParticipant = new Map<string, number[]>()
    const snapshots = yield* Effect.forEach(participants, (participant) =>
      Effect.gen(function* () {
        const sync = yield* args.host.observeSync(participant)
        const syncRecord = args.record({
          origin: 'observation',
          clientId: participant.clientId,
          sessionId: participant.sessionId,
          payload: { _tag: 'sync.snapshot', ...syncObservationPayload(sync) },
        })
        const evidence = [syncRecord.index]
        const state: Record<string, Schema.Json> = {}
        for (const inspector of inspectorNames) {
          const operationId = `inspect:${participantKey(participant)}:${inspector}`
          const inspected = yield* args.host.inspectState({ operationId, target: participant, inspector })
          state[inspector] = inspected
          const stateRecord = args.record({
            origin: 'observation',
            correlationId: operationId,
            clientId: participant.clientId,
            sessionId: participant.sessionId,
            payload: { _tag: 'state.snapshot', inspector, value: inspected },
          })
          evidence.push(stateRecord.index)
        }
        evidenceByParticipant.set(participantKey(participant), evidence)
        return { participant, sync, state }
      }),
    )
    return { snapshots, evidenceByParticipant }
  })
}

const evaluateOracles = (args: {
  oracles: ReadonlyArray<ScenarioOracle>
  snapshots: ReadonlyArray<ParticipantSnapshot>
  evidenceByParticipant: ReadonlyMap<string, ReadonlyArray<number>>
  trace: ReadonlyArray<ScenarioTraceRecord>
  record: TraceRecorder
}): ReadonlyArray<OracleVerdict> =>
  args.oracles.map((oracle) => {
    const verdict =
      oracle._tag === 'operation-history'
        ? evaluateOperationHistoryOracle(oracle, args.trace)
        : oracle._tag === 'eventlog-convergence'
          ? evaluateEventlogConvergenceOracle(oracle, args.trace)
          : evaluateSnapshotOracle(
              oracle,
              oracle.participants.map((participant) =>
                args.snapshots.find((snapshot) => participantKey(snapshot.participant) === participantKey(participant)),
              ),
              oracle.participants.flatMap(
                (participant) => args.evidenceByParticipant.get(participantKey(participant)) ?? [],
              ),
            )
    args.record({
      origin: 'verdict',
      correlationId: oracle.id,
      payload: {
        _tag: 'oracle.verdict',
        oracleId: verdict.oracleId,
        oracle: verdict.oracle,
        status: verdict.status,
        summary: verdict.summary,
        evidence: [...verdict.evidence],
      },
    })
    return verdict
  })

const evaluateSnapshotOracle = (
  oracle: Exclude<ScenarioOracle, OperationHistoryOracle | EventlogConvergenceOracle>,
  selected: ReadonlyArray<ParticipantSnapshot | undefined>,
  evidence: ReadonlyArray<number>,
): OracleVerdict => {
  if (selected.some((snapshot) => snapshot === undefined) === true) {
    return failedVerdict(oracle, evidence, 'One or more expected participant snapshots are missing')
  }
  const snapshots = selected.filter((snapshot): snapshot is ParticipantSnapshot => snapshot !== undefined)

  switch (oracle._tag) {
    case 'pending-resolution': {
      const passed = snapshots.every((snapshot) => snapshot.sync.pendingCount === 0 && snapshot.sync.isSynced === true)
      return passed === true
        ? passedVerdict(oracle, evidence, 'All expected participants have resolved pending events')
        : failedVerdict(oracle, evidence, 'At least one expected participant still has pending events')
    }
    case 'state-convergence': {
      const values = snapshots.map((snapshot) => canonicalJson(snapshot.state[oracle.inspector]))
      const passed = new Set(values).size === 1 && values[0] !== undefined
      return passed === true
        ? passedVerdict(oracle, evidence, `Inspector ${oracle.inspector} converged across expected participants`)
        : failedVerdict(oracle, evidence, `Inspector ${oracle.inspector} diverged across expected participants`)
    }
    case 'state-contains-ids': {
      const missingByParticipant = snapshots.flatMap((snapshot) => {
        const ids = readIds(snapshot.state[oracle.inspector])
        const missing = oracle.expectedIds.filter((id) => ids.has(id) === false)
        return missing.length === 0 ? [] : [`${participantKey(snapshot.participant)}: ${missing.join(', ')}`]
      })
      return missingByParticipant.length === 0
        ? passedVerdict(oracle, evidence, `All expected IDs are present in inspector ${oracle.inspector}`)
        : failedVerdict(oracle, evidence, `Missing IDs (${missingByParticipant.join('; ')})`)
    }
  }
}

type EventlogConvergenceOracle = Extract<ScenarioOracle, { readonly _tag: 'eventlog-convergence' }>

interface EventlogCaptureEvidence {
  readonly backend: {
    readonly recordIndex: number
    readonly head: string
    readonly events: ReadonlyArray<ObservedEvent>
  }
  readonly participants: ReadonlyMap<string, ParticipantEventlogEvidence>
}

interface ParticipantEventlogEvidence {
  readonly recordIndex: number
  readonly observation: ComponentSyncObservation
}

interface EventlogCaptureAccumulator {
  backend?: EventlogCaptureEvidence['backend']
  readonly participants: Map<string, ParticipantEventlogEvidence>
}

const evaluateEventlogConvergenceOracle = (
  oracle: EventlogConvergenceOracle,
  trace: ReadonlyArray<ScenarioTraceRecord>,
): OracleVerdict => {
  const evidence = latestCompleteEventlogCapture(trace, oracle.participants)
  if (evidence === undefined) {
    return failedVerdict(
      oracle,
      [],
      'Eventlog convergence has insufficient evidence: no complete backend and participant observation capture',
    )
  }

  const backendEvents = evidence.backend.events.filter((event) => event.disposition === 'confirmed')
  const evidenceIndexes = [
    evidence.backend.recordIndex,
    ...oracle.participants.flatMap((participant) => {
      const participantEvidence = evidence.participants.get(participantKey(participant))
      return participantEvidence === undefined ? [] : [participantEvidence.recordIndex]
    }),
  ]

  for (const participant of oracle.participants) {
    const key = participantKey(participant)
    const participantEvidence = evidence.participants.get(key)
    if (participantEvidence === undefined) {
      return failedVerdict(oracle, evidenceIndexes, `Eventlog convergence has insufficient evidence for ${key}`)
    }

    const observation = participantEvidence.observation
    const settledAtBackendHead =
      observation.pendingCount === 0 &&
      globalPosition(observation.localHead) === globalPosition(evidence.backend.head) &&
      globalPosition(observation.upstreamHead) === globalPosition(evidence.backend.head)
    if (settledAtBackendHead === false) {
      return failedVerdict(
        oracle,
        evidenceIndexes,
        `${key} is not settled at authoritative backend head ${evidence.backend.head}`,
      )
    }

    const participantEvents = observation.events.filter((event) => event.disposition === 'confirmed')
    const mismatch = firstEventlogMismatch(backendEvents, participantEvents)
    if (mismatch !== undefined) {
      return failedVerdict(
        oracle,
        evidenceIndexes,
        `${key} diverged from the authoritative Eventlog at position ${mismatch.position}: expected ${mismatch.expected}, observed ${mismatch.observed}`,
      )
    }
  }

  return passedVerdict(
    oracle,
    evidenceIndexes,
    `All expected participants match the authoritative Eventlog through ${evidence.backend.head}`,
  )
}

const evaluateOperationHistoryOracle = (
  oracle: OperationHistoryOracle,
  trace: ReadonlyArray<ScenarioTraceRecord>,
): OracleVerdict => {
  const history = deriveScenarioOperationHistoryProjection(trace)
  const selected = oracle.operationIds.map((operationId) =>
    history.operations.find((operation) => operation.operationId === operationId),
  )
  const evidence = selected.flatMap((operation) =>
    operation === undefined
      ? []
      : [operation.invocationRecordIndex, operation.outcomeRecordIndex].filter(
          (index): index is number => index !== null,
        ),
  )
  const missing = oracle.operationIds.filter((_operationId, index) => selected[index] === undefined)
  if (missing.length > 0) {
    return failedVerdict(oracle, evidence, `Operation history omitted: ${missing.join(', ')}`)
  }
  const operations = selected.filter((operation) => operation !== undefined)
  const unacceptable = operations.filter(
    (operation) =>
      operation.status === 'pending' || (operation.status === 'indefinite' && oracle.allowIndefinite === false),
  )
  if (unacceptable.length > 0) {
    return failedVerdict(
      oracle,
      evidence,
      `Operation history has unacceptable outcomes: ${unacceptable.map((operation) => `${operation.operationId}=${operation.status}`).join(', ')}`,
    )
  }
  if (oracle.requireOverlap === true && deriveOverlappingScenarioOperationPairs(operations).length === 0) {
    return failedVerdict(oracle, evidence, 'Selected operations did not overlap')
  }
  return passedVerdict(
    oracle,
    evidence,
    `${operations.length} selected operations have terminal${oracle.allowIndefinite === true ? '' : ', non-indefinite'} outcomes${oracle.requireOverlap === true ? ' and overlapping invocation intervals' : ''}`,
  )
}

/** Resolves every named workload before creating participants and retains its deterministic expansion for the run. */
const prepareWorkloadExpansions = (args: {
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

const validateExecution = (args: {
  scenario: ScenarioAst
  applicationId: string
  host: ParticipantHost
  execution: ExecutionConfiguration
}): Effect.Effect<void, ScenarioOperationError> => {
  try {
    // A caller can construct a value typed as ScenarioAst without using the
    // authoring constructor, so execution repeats its semantic validation.
    defineScenario(args.scenario)
  } catch (cause) {
    return Effect.fail(
      new ScenarioOperationError(
        'invalid-scenario',
        cause instanceof Error ? cause.message : `Invalid scenario: ${String(cause)}`,
      ),
    )
  }
  if (args.scenario.applicationId !== args.applicationId) {
    return Effect.fail(
      new ScenarioOperationError(
        'application-mismatch',
        `Scenario requires ${args.scenario.applicationId}, received ${args.applicationId}`,
      ),
    )
  }
  if (args.execution.participantProfile !== args.host.capabilities.profile) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Execution selected ${args.execution.participantProfile}, received ${args.host.capabilities.profile} host`,
      ),
    )
  }
  if (args.execution.syncBackend !== args.host.backendId) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Execution selected ${args.execution.syncBackend}, received ${args.host.backendId} backend`,
      ),
    )
  }
  const available = new Set(args.host.capabilities.capabilities)
  const stateCapability = args.execution.stateProfile === 'opfs' ? 'opfs-state' : 'sqlite-state'
  if (available.has(stateCapability) === false) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Host ${args.host.capabilities.profile} does not provide ${args.execution.stateProfile} state`,
      ),
    )
  }
  const oversizedClients = sessionsBeyondHostLimit({
    scenario: args.scenario,
    maximumSessionsPerClient: args.host.capabilities.maximumSessionsPerClient,
  })
  if (oversizedClients.length > 0) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Host ${args.host.capabilities.profile} supports at most ${args.host.capabilities.maximumSessionsPerClient} session(s) per Client; requested: ${oversizedClients.map(({ clientId, requested }) => `${clientId} (${requested})`).join(', ')}`,
      ),
    )
  }
  const missing = deriveScenarioRequirements(args.scenario).filter((capability) => available.has(capability) === false)
  if (missing.length > 0) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Host ${args.host.capabilities.profile} does not provide: ${missing.join(', ')}`,
      ),
    )
  }
  return Effect.void
}

const makeScenarioArtifact = (input: {
  args: {
    scenario: ScenarioAst
    applicationId: string
    host: ParticipantHost
    options?: RunScenarioOptions
  }
  execution: ExecutionConfiguration
  runId: string
  trace: ReadonlyArray<ScenarioTraceRecord>
  verdicts: ReadonlyArray<OracleVerdict>
  snapshots: ReadonlyArray<ParticipantSnapshot>
  status: 'passed' | 'failed'
}): Effect.Effect<ScenarioRunArtifact> =>
  Schema.decodeUnknownEffect(ScenarioRunArtifact)({
    artifactVersion: scenarioArtifactVersion,
    descriptor: {
      runId: input.runId,
      scenarioId: input.args.scenario.id,
      scenarioVersion: input.args.scenario.version,
      traceVersion: scenarioTraceVersion,
      applicationId: input.args.applicationId,
      sourceRevision: input.args.options?.sourceRevision ?? 'working-tree',
      seed: input.args.scenario.seed,
      reproductionMode: 'seeded',
      execution: input.execution,
      capabilities: input.args.host.capabilities,
      componentVersions: input.args.host.componentVersions,
    },
    scenario: input.args.scenario,
    trace: input.trace,
    verdicts: input.verdicts,
    snapshots: input.snapshots,
    status: input.status,
  }).pipe(Effect.orDie)

const describeHostError = (error: HostError): { readonly code: string; readonly message: string } => {
  if (error instanceof ScenarioOperationError) return { code: error.code, message: error.message }
  return {
    code: error._tag,
    message: error.note ?? formatUnknownFailure(error.cause),
  }
}

type RecoveringFault =
  | {
      readonly scope: 'client'
      readonly clientId: string
      readonly faultId: string
      readonly removalRecordIndex: number
    }
  | {
      readonly scope: 'backend'
      readonly faultId: string
      readonly removalRecordIndex: number
    }

interface ScenarioFaultState {
  readonly activeByClient: Map<string, string>
  readonly recoveringByClient: Map<string, Omit<Extract<RecoveringFault, { readonly scope: 'client' }>, 'clientId'>>
  readonly pendingByClient: Map<string, PendingFaultTransition>
  readonly backend: {
    active?: string
    recovering?: Extract<RecoveringFault, { readonly scope: 'backend' }>
    pending?: PendingBackendFaultTransition
  }
}

interface PendingFaultTransition {
  readonly operationId: string
  readonly connected: boolean
  readonly faultId: string
  readonly acknowledgementRecordIndex: number
}

interface PendingBackendFaultTransition {
  readonly operationId: string
  readonly available: boolean
  readonly faultId: string
  readonly acknowledgementRecordIndex: number
}

const makeFaultState = (): ScenarioFaultState => ({
  activeByClient: new Map(),
  recoveringByClient: new Map(),
  pendingByClient: new Map(),
  backend: {},
})

const recordObservedFaultTransition = (args: {
  clientId: string
  connected: boolean
  connectivityRecord: ScenarioTraceRecord
  faultState: ScenarioFaultState
  record: TraceRecorder
  phaseId?: string
  captureId: string
  occurrence: HostObservationOccurrence
}): void => {
  const pending = args.faultState.pendingByClient.get(args.clientId)
  if (pending === undefined || pending.connected !== args.connected) return
  args.faultState.pendingByClient.delete(args.clientId)

  const input = {
    origin: 'observation' as const,
    correlationId: pending.operationId,
    clientId: args.clientId,
    phaseId: args.phaseId,
    captureId: args.captureId,
    evidence: 'first-observed' as const,
    occurrence: args.occurrence,
    causedBy: [pending.acknowledgementRecordIndex, args.connectivityRecord.index],
  }
  if (pending.connected === false) {
    args.faultState.recoveringByClient.delete(args.clientId)
    args.faultState.activeByClient.set(args.clientId, pending.faultId)
    args.record({
      ...input,
      payload: { _tag: 'fault.injected', faultId: pending.faultId, fault: 'client-disconnected' },
    })
  } else {
    args.faultState.activeByClient.delete(args.clientId)
    const removal = args.record({
      ...input,
      payload: { _tag: 'fault.removed', faultId: pending.faultId, fault: 'client-disconnected' },
    })
    args.faultState.recoveringByClient.set(args.clientId, {
      scope: 'client',
      faultId: pending.faultId,
      removalRecordIndex: removal.index,
    })
  }
}

const recordObservedBackendFaultTransition = (args: {
  available: boolean
  backendRecord: ScenarioTraceRecord
  faultState: ScenarioFaultState
  record: TraceRecorder
  phaseId?: string
  captureId: string
  occurrence: HostObservationOccurrence
}): void => {
  const pending = args.faultState.backend.pending
  if (pending === undefined || pending.available !== args.available) return
  args.faultState.backend.pending = undefined

  const input = {
    origin: 'observation' as const,
    correlationId: pending.operationId,
    phaseId: args.phaseId,
    captureId: args.captureId,
    evidence: 'first-observed' as const,
    occurrence: args.occurrence,
    causedBy: [pending.acknowledgementRecordIndex, args.backendRecord.index],
  }
  if (pending.available === false) {
    args.faultState.backend.recovering = undefined
    args.faultState.backend.active = pending.faultId
    args.record({
      ...input,
      payload: { _tag: 'fault.injected', faultId: pending.faultId, fault: 'backend-unavailable' },
    })
  } else {
    args.faultState.backend.active = undefined
    const removal = args.record({
      ...input,
      payload: { _tag: 'fault.removed', faultId: pending.faultId, fault: 'backend-unavailable' },
    })
    args.faultState.backend.recovering = {
      scope: 'backend',
      faultId: pending.faultId,
      removalRecordIndex: removal.index,
    }
  }
}

const selectedRecoveryFaults = (
  state: ScenarioFaultState,
  participants: ReadonlyArray<ParticipantRef>,
): ReadonlyArray<RecoveringFault> => {
  const selectedClientIds = new Set(participants.map((participant) => participant.clientId))
  return [
    ...[...state.recoveringByClient.entries()].flatMap(([clientId, fault]) =>
      selectedClientIds.has(clientId) === true ? [{ clientId, ...fault }] : [],
    ),
    ...(state.backend.recovering === undefined ? [] : [state.backend.recovering]),
  ]
}

const recordOperationFailure = (args: {
  record: TraceRecorder
  operationId: string
  phaseId?: string
  error: HostError
}): ScenarioTraceRecord =>
  args.record({
    origin: 'observation',
    correlationId: args.operationId,
    phaseId: args.phaseId,
    causedBy: args.record.instructionIndex(args.operationId),
    payload: {
      _tag: 'operation.outcome',
      status: operationOutcome(args.error),
      ...describeHostError(args.error),
    },
  })

const operationOutcome = (error: HostError): 'definite-failure' | 'indefinite' =>
  error instanceof ScenarioOperationError ? error.operationOutcome : 'indefinite'

const formatUnknownFailure = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}

const settlementTimeoutError = (
  correlationId: string,
  timeoutMs: number,
  observations: ReadonlyArray<SyncObservationPayload>,
): ScenarioOperationError =>
  new ScenarioOperationError(
    'settlement-timeout',
    `Settlement ${correlationId} did not reach a stable fixed point within ${timeoutMs}ms: ${canonicalJson(observations)}`,
  )

const observationsAreSettled = (observations: ReadonlyArray<SyncObservation>): boolean => {
  if (observations.length === 0) return false
  const heads = new Set(observations.map((observation) => globalPosition(observation.upstreamHead)))
  return (
    heads.size === 1 &&
    observations.every(
      (observation) =>
        observation.pendingCount === 0 &&
        observation.isSynced === true &&
        globalPosition(observation.localHead) === globalPosition(observation.upstreamHead),
    )
  )
}

const globalPosition = (head: string): number => EventSequenceNumber.Client.fromString(head).global

/** Selects one non-atomic capture only when it contains every fact the oracle compares. */
const latestCompleteEventlogCapture = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
  participants: ReadonlyArray<ParticipantRef>,
): EventlogCaptureEvidence | undefined => {
  const participantKeys = new Set(participants.map(participantKey))
  const captures = new Map<string, EventlogCaptureAccumulator>()

  for (const record of trace) {
    if (record.captureId === null) continue
    const capture =
      captures.get(record.captureId) ??
      ({ participants: new Map<string, ParticipantEventlogEvidence>() } satisfies EventlogCaptureAccumulator)
    captures.set(record.captureId, capture)

    if (record.payload._tag === 'backend.observed') {
      capture.backend = {
        recordIndex: record.index,
        head: record.payload.observation.head,
        events: record.payload.observation.events,
      }
    } else if (
      record.payload._tag === 'session.sync.observed' &&
      record.clientId !== null &&
      record.sessionId !== null
    ) {
      const key = participantKey({ clientId: record.clientId, sessionId: record.sessionId })
      if (participantKeys.has(key) === true) {
        capture.participants.set(key, {
          recordIndex: record.index,
          observation: record.payload.observation,
        })
      }
    }
  }

  for (const capture of [...captures.values()].toReversed()) {
    if (
      capture.backend !== undefined &&
      participants.every((participant) => capture.participants.has(participantKey(participant))) === true
    ) {
      return { backend: capture.backend, participants: capture.participants }
    }
  }
  return undefined
}

const firstEventlogMismatch = (
  expectedEvents: ReadonlyArray<ObservedEvent>,
  observedEvents: ReadonlyArray<ObservedEvent>,
):
  | {
      readonly position: string
      readonly expected: string
      readonly observed: string
    }
  | undefined => {
  const eventCount = Math.max(expectedEvents.length, observedEvents.length)
  for (let index = 0; index < eventCount; index += 1) {
    const expected = expectedEvents[index]
    const observed = observedEvents[index]
    if (expected === undefined || observed === undefined || eventFact(expected) !== eventFact(observed)) {
      return {
        position: expected?.position ?? observed?.position ?? `index ${index}`,
        expected: describeEventFact(expected),
        observed: describeEventFact(observed),
      }
    }
  }
  return undefined
}

/** Eventlog equality uses portable Event facts; inferred eventRef correlation is non-authoritative. */
const eventFact = (event: ObservedEvent): string =>
  canonicalJson({
    name: event.name,
    args: event.args,
    origin: event.origin,
    position: globalPosition(event.position),
    parentPosition: globalPosition(event.parentPosition),
  })!

const describeEventFact = (event: ObservedEvent | undefined): string =>
  event === undefined ? 'no Event' : `${event.name} from ${participantKey(event.origin)} at ${event.position}`

const syncObservationPayload = (observation: SyncObservation): SyncObservationPayload => ({
  participant: participantKey(observation.participant),
  localHead: observation.localHead,
  upstreamHead: observation.upstreamHead,
  pendingCount: observation.pendingCount,
  isSynced: observation.isSynced,
})

const canonicalJson = (value: Schema.Json | undefined): string | undefined =>
  value === undefined ? undefined : Schema.encodeUnknownSync(Schema.UnknownFromJsonString)(sortJson(value))

const sortJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value) === true) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}

const readIds = (value: Schema.Json | undefined): ReadonlySet<string> => {
  if (Array.isArray(value) === false) return new Set()
  return new Set(
    value.flatMap((item) =>
      item !== null && typeof item === 'object' && Array.isArray(item) === false && typeof item.id === 'string'
        ? [item.id]
        : [],
    ),
  )
}

const passedVerdict = (oracle: ScenarioOracle, evidence: ReadonlyArray<number>, summary: string): OracleVerdict => ({
  oracleId: oracle.id,
  oracle: oracle._tag,
  status: 'passed',
  summary,
  evidence,
})

const failedVerdict = (oracle: ScenarioOracle, evidence: ReadonlyArray<number>, summary: string): OracleVerdict => ({
  oracleId: oracle.id,
  oracle: oracle._tag,
  status: 'failed',
  summary,
  evidence,
})
