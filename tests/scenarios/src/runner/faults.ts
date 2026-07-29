import { ScenarioOperationError } from '../application.ts'
import type { HostError } from '../host.ts'
import type {
  HostObservationOccurrence,
  ParticipantRef,
  ScenarioTraceRecord,
  SyncObservation,
  SyncObservationPayload,
} from '../model.ts'
import { canonicalJson, globalPosition } from './eventlog.ts'
import { describeHostError } from './support.ts'
import type { TraceRecorder } from './trace-recorder.ts'

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

export interface ScenarioFaultState {
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

export const makeFaultState = (): ScenarioFaultState => ({
  activeByClient: new Map(),
  recoveringByClient: new Map(),
  pendingByClient: new Map(),
  backend: {},
})

export const recordObservedFaultTransition = (args: {
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

export const recordObservedBackendFaultTransition = (args: {
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

export const selectedRecoveryFaults = (
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

export const recordOperationFailure = (args: {
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

export const settlementTimeoutError = (
  correlationId: string,
  timeoutMs: number,
  observations: ReadonlyArray<SyncObservationPayload>,
): ScenarioOperationError =>
  new ScenarioOperationError(
    'settlement-timeout',
    `Settlement ${correlationId} did not reach a stable fixed point within ${timeoutMs}ms: ${canonicalJson(observations)}`,
  )

export const observationsAreSettled = (observations: ReadonlyArray<SyncObservation>): boolean => {
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
