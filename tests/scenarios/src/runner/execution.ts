import { Deferred, Effect, Exit, type OtelTracer, type Scope } from '@livestore/utils/effect'

import { type GeneratedWorkloadAction, ScenarioOperationError } from '../application/definition.ts'
import {
  type ClientDefinition,
  type ParallelOperationStep,
  participantKey,
  type ScenarioStep,
  type ScenarioTraceRecord,
  type WorkloadStep,
} from '../model.ts'
import type { HostError, ParticipantHost } from '../profiles/contract.ts'
import { syncObservationPayload } from './eventlog.ts'
import { type ScenarioFaultState, recordOperationFailure } from './faults.ts'
import { awaitSettlement } from './observations.ts'
import type { TraceRecorder } from './trace-recorder.ts'

export interface PreparedWorkloadAction extends GeneratedWorkloadAction {
  readonly id: string
}

export interface PreparedWorkloadExpansion {
  readonly seed: number
  readonly actions: ReadonlyArray<PreparedWorkloadAction>
}

export type PreparedWorkloadExpansions = ReadonlyMap<string, PreparedWorkloadExpansion>

export const executeParallelStep = (args: {
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

export const executeStep = (args: {
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

export const executeClientCreation = (args: {
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
