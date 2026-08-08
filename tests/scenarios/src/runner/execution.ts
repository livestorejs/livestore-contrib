import { Deferred, Effect, Exit, type OtelTracer, type Scope } from '@livestore/utils/effect'

import { ScenarioOperationError } from '../application/definition.ts'
import {
  type ActionStep,
  type ActionSequenceStep,
  type ClientDefinition,
  type ParallelOperationStep,
  participantKey,
  type ScenarioInstruction,
  type ScenarioTraceRecord,
} from '../model.ts'
import type { HostError, ParticipantHost } from '../profiles/contract.ts'
import { syncObservationPayload } from './eventlog.ts'
import { type ScenarioFaultState, recordOperationFailure } from './faults.ts'
import { awaitStabilization } from './observations.ts'
import type { TraceRecorder } from './trace-recorder.ts'

export const executeParallelInstruction = (args: {
  host: ParticipantHost
  storeId: string
  record: TraceRecorder
  operations: ReadonlyArray<ParallelOperationStep>
  faultState: ScenarioFaultState
  stabilizationTimeoutMs: number
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
        executeInstruction({ ...args, instruction: operation, onInvoked }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              recordOperationFailure({
                record: args.record,
                operationId: operation.id,
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

export const executeInstruction = (args: {
  host: ParticipantHost
  storeId: string
  record: TraceRecorder
  instruction: Exclude<ScenarioInstruction, { readonly _tag: 'parallel' }>
  faultState: ScenarioFaultState
  stabilizationTimeoutMs: number
  onInvoked?: () => Effect.Effect<void>
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> => {
  switch (args.instruction._tag) {
    case 'annotation':
      args.record({
        origin: 'observation',
        correlationId: args.instruction.id,
        payload: { _tag: 'annotation.reached', text: args.instruction.text },
      })
      return Effect.void
    case 'wait': {
      const instruction = args.instruction
      return Effect.gen(function* () {
        const requested = args.record({
          origin: 'instruction',
          correlationId: instruction.id,
          payload: { _tag: 'wait.requested', durationMs: instruction.durationMs },
        })
        const actualDurationMs = yield* waitAtLeast(instruction.durationMs)
        args.record({
          origin: 'acknowledgement',
          correlationId: instruction.id,
          causedBy: [requested.index],
          payload: {
            _tag: 'wait.completed',
            requestedDurationMs: instruction.durationMs,
            actualDurationMs,
          },
        })
      })
    }
    case 'create-client':
      return executeClientCreation({
        host: args.host,
        record: args.record,
        operationId: args.instruction.id,
        storeId: args.storeId,
        client: args.instruction.client,
      })
    case 'add-session': {
      const instruction = args.instruction
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: instruction.id,
          clientId: instruction.target.clientId,
          sessionId: instruction.target.sessionId,
          payload: { _tag: 'lifecycle.session-add.requested' },
        })
        yield* args.host.addSession({ operationId: instruction.id, target: instruction.target })
        args.record({
          origin: 'acknowledgement',
          correlationId: instruction.id,
          clientId: instruction.target.clientId,
          sessionId: instruction.target.sessionId,
          payload: { _tag: 'lifecycle.session-added' },
        })
      })
    }
    case 'action': {
      return executeAction({ ...args, action: args.instruction }).pipe(Effect.asVoid)
    }
    case 'action-sequence':
      return executeActionSequence({
        host: args.host,
        record: args.record,
        instruction: args.instruction,
      })
    case 'disconnect':
    case 'reconnect': {
      const connected = args.instruction._tag === 'reconnect'
      return setConnectivity({
        host: args.host,
        record: args.record,
        clientId: args.instruction.clientId,
        operationId: args.instruction.id,
        connected,
        faultState: args.faultState,
        onInvoked: args.onInvoked,
      })
    }
    case 'backend-unavailable':
    case 'backend-available':
      return setBackendAvailability({
        host: args.host,
        record: args.record,
        operationId: args.instruction.id,
        available: args.instruction._tag === 'backend-available',
        faultState: args.faultState,
        onInvoked: args.onInvoked,
      })
    case 'stop-session':
    case 'restart-session': {
      const instruction = args.instruction
      const restarting = instruction._tag === 'restart-session'
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: instruction.id,
          clientId: instruction.target.clientId,
          sessionId: instruction.target.sessionId,
          payload:
            restarting === true
              ? { _tag: 'lifecycle.session-restart.requested' }
              : { _tag: 'lifecycle.session-stop.requested' },
        })
        if (args.onInvoked !== undefined) yield* args.onInvoked()
        const command = { operationId: instruction.id, target: instruction.target }
        if (restarting === true) yield* args.host.restartSession(command)
        else yield* args.host.stopSession(command)
        args.record({
          origin: 'acknowledgement',
          correlationId: instruction.id,
          clientId: instruction.target.clientId,
          sessionId: instruction.target.sessionId,
          payload:
            restarting === true ? { _tag: 'lifecycle.session-restarted' } : { _tag: 'lifecycle.session-stopped' },
        })
      })
    }
    case 'restart-client': {
      const instruction = args.instruction
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: instruction.id,
          clientId: instruction.clientId,
          payload: { _tag: 'lifecycle.client-restart.requested' },
        })
        if (args.onInvoked !== undefined) yield* args.onInvoked()
        yield* args.host.restartClient({ operationId: instruction.id, clientId: instruction.clientId })
        args.record({
          origin: 'acknowledgement',
          correlationId: instruction.id,
          clientId: instruction.clientId,
          payload: { _tag: 'lifecycle.client-restarted' },
        })
      })
    }
    case 'settle': {
      const instruction = args.instruction
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: instruction.id,
          payload: {
            _tag: 'settlement.requested',
            participants: instruction.participants.map(participantKey),
            healDisconnectedClients: [...instruction.healDisconnectedClients],
            timeoutMs: args.stabilizationTimeoutMs,
          },
        })
        for (const clientId of instruction.healDisconnectedClients) {
          const operationId = `${instruction.id}:heal:${clientId}`
          yield* setConnectivity({
            host: args.host,
            record: args.record,
            clientId,
            operationId,
            connected: true,
            faultState: args.faultState,
          }).pipe(
            Effect.catch((error) => {
              recordOperationFailure({ record: args.record, operationId, error })
              return Effect.fail(error)
            }),
          )
        }
        const inFlightOperationIds = args.record.pendingOperationIds([instruction.id])
        if (inFlightOperationIds.length > 0) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'operations-in-flight',
              `Settlement ${instruction.id} cannot establish quiescence with operations in flight: ${inFlightOperationIds.join(', ')}`,
            ),
          )
        }
        args.record({
          origin: 'observation',
          correlationId: instruction.id,
          causedBy: args.record.instructionIndex(instruction.id),
          payload: { _tag: 'quiescence.reached', inFlightOperationIds },
        })
        const settled = yield* awaitStabilization({
          host: args.host,
          participants: instruction.participants,
          timeoutMs: args.stabilizationTimeoutMs,
          record: args.record,
          correlationId: instruction.id,
          faultState: args.faultState,
          kind: 'settlement',
        })
        args.record({
          origin: 'acknowledgement',
          correlationId: instruction.id,
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
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    args.record({
      origin: 'instruction',
      correlationId: args.operationId,
      clientId: args.client.id,
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
      payload: { _tag: 'client.created', status: 'acknowledged' },
    })
  })

const executeAction = (args: {
  host: ParticipantHost
  record: TraceRecorder
  action: ActionStep
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
      payload: { _tag: 'action.completed', action: args.action.action, status: 'acknowledged' },
    })
  })

const executeActionSequence = (args: {
  host: ParticipantHost
  record: TraceRecorder
  instruction: ActionSequenceStep
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const instruction = args.record({
      origin: 'instruction',
      correlationId: args.instruction.id,
      payload: {
        _tag: 'action-sequence.requested',
        description: args.instruction.description,
        targets: [...new Set(args.instruction.actions.map((action) => participantKey(action.target)))],
        count: args.instruction.actions.length,
        seed: args.instruction.seed,
        delayBetweenActionsMs: args.instruction.delayBetweenActionsMs,
      },
    })
    const acknowledgements: ScenarioTraceRecord[] = []
    let precedingDelay: ScenarioTraceRecord | undefined
    for (const [index, action] of args.instruction.actions.entries()) {
      const acknowledgement = yield* executeAction({
        host: args.host,
        record: args.record,
        action,
        causationId: args.instruction.id,
        causedBy: [instruction.index, ...(precedingDelay === undefined ? [] : [precedingDelay.index])],
      }).pipe(
        Effect.catch((error) => {
          recordOperationFailure({ record: args.record, operationId: action.id, error })
          return Effect.fail(error)
        }),
      )
      acknowledgements.push(acknowledgement)
      const nextAction = args.instruction.actions[index + 1]
      if (args.instruction.delayBetweenActionsMs !== null && nextAction !== undefined) {
        const correlationId = `${args.instruction.id}:delay-${String(index + 1).padStart(4, '0')}`
        const requested = args.record({
          origin: 'observation',
          correlationId,
          causationId: args.instruction.id,
          causedBy: [acknowledgement.index],
          payload: {
            _tag: 'action-sequence.delay.requested',
            durationMs: args.instruction.delayBetweenActionsMs,
            afterActionId: action.id,
            beforeActionId: nextAction.id,
          },
        })
        const actualDurationMs = yield* waitAtLeast(args.instruction.delayBetweenActionsMs)
        precedingDelay = args.record({
          origin: 'observation',
          correlationId,
          causationId: args.instruction.id,
          causedBy: [requested.index],
          payload: {
            _tag: 'action-sequence.delay.completed',
            requestedDurationMs: args.instruction.delayBetweenActionsMs,
            actualDurationMs,
            afterActionId: action.id,
            beforeActionId: nextAction.id,
          },
        })
      }
    }
    args.record({
      origin: 'acknowledgement',
      correlationId: args.instruction.id,
      causedBy: [instruction.index, ...acknowledgements.map((record) => record.index)],
      payload: {
        _tag: 'action-sequence.completed',
        actionIds: args.instruction.actions.map((action) => action.id),
        status: 'acknowledged',
      },
    })
  })

const waitAtLeast = (durationMs: number): Effect.Effect<number> => {
  const startedAt = performance.now()
  const loop: Effect.Effect<number> = Effect.suspend(() => {
    const elapsed = performance.now() - startedAt
    const remaining = durationMs - elapsed
    return remaining <= 0 ? Effect.succeed(elapsed) : Effect.sleep(remaining).pipe(Effect.andThen(loop))
  })
  return loop
}

const setConnectivity = (args: {
  host: ParticipantHost
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
      payload: { _tag: 'backend.availability.requested', available: args.available },
    })
    if (args.onInvoked !== undefined) yield* args.onInvoked()
    yield* args.host.setBackendAvailability({ operationId: args.operationId, available: args.available })
    const acknowledgement = args.record({
      origin: 'acknowledgement',
      correlationId: args.operationId,
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
