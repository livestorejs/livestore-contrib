import { Schema } from '@livestore/utils/effect'

export const scenarioTraceVersion = 3 as const
export const scenarioArtifactVersion = 4 as const

export const ParticipantProfile = Schema.Literals(['in-process', 'process', 'browser'])
export type ParticipantProfile = typeof ParticipantProfile.Type

export const SyncBackendRealization = Schema.Literals(['mock', 'local-sync-cf'])
export type SyncBackendRealization = typeof SyncBackendRealization.Type

export const StateProfile = Schema.Literals(['sqlite', 'opfs'])
export type StateProfile = typeof StateProfile.Type

export const ExecutionConfiguration = Schema.Struct({
  participantProfile: ParticipantProfile,
  syncBackend: SyncBackendRealization,
  stateProfile: StateProfile,
})
export type ExecutionConfiguration = typeof ExecutionConfiguration.Type

export const ParticipantRef = Schema.Struct({
  clientId: Schema.String,
  sessionId: Schema.String,
})
export type ParticipantRef = typeof ParticipantRef.Type

export const ClientDefinition = Schema.Struct({
  id: Schema.String,
  sessions: Schema.Array(Schema.String),
  initiallyConnected: Schema.Boolean,
})
export type ClientDefinition = typeof ClientDefinition.Type

export const ActionStep = Schema.TaggedStruct('action', {
  id: Schema.String,
  target: ParticipantRef,
  action: Schema.String,
  input: Schema.Json,
})

export const DisconnectStep = Schema.TaggedStruct('disconnect', {
  id: Schema.String,
  clientId: Schema.String,
})

export const ReconnectStep = Schema.TaggedStruct('reconnect', {
  id: Schema.String,
  clientId: Schema.String,
})

export const StopSessionStep = Schema.TaggedStruct('stop-session', {
  id: Schema.String,
  target: ParticipantRef,
})

export const RestartSessionStep = Schema.TaggedStruct('restart-session', {
  id: Schema.String,
  target: ParticipantRef,
})

export const RestartClientStep = Schema.TaggedStruct('restart-client', {
  id: Schema.String,
  clientId: Schema.String,
})

export const SettleStep = Schema.TaggedStruct('settle', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
  healDisconnectedClients: Schema.Array(Schema.String),
  timeoutMs: Schema.Finite,
})

export const ScenarioStep = Schema.Union([
  ActionStep,
  DisconnectStep,
  ReconnectStep,
  StopSessionStep,
  RestartSessionStep,
  RestartClientStep,
  SettleStep,
])
export type ScenarioStep = typeof ScenarioStep.Type

export const ScenarioPhase = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  steps: Schema.Array(ScenarioStep),
})
export type ScenarioPhase = typeof ScenarioPhase.Type

export const PendingResolutionOracle = Schema.TaggedStruct('pending-resolution', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
})

export const EventlogConvergenceOracle = Schema.TaggedStruct('eventlog-convergence', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
})

export const StateConvergenceOracle = Schema.TaggedStruct('state-convergence', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
  inspector: Schema.String,
})

export const StateContainsIdsOracle = Schema.TaggedStruct('state-contains-ids', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
  inspector: Schema.String,
  expectedIds: Schema.Array(Schema.String),
})

export const ScenarioOracle = Schema.Union([
  PendingResolutionOracle,
  EventlogConvergenceOracle,
  StateConvergenceOracle,
  StateContainsIdsOracle,
])
export type ScenarioOracle = typeof ScenarioOracle.Type

export const ScenarioAst = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  description: Schema.String,
  tags: Schema.Array(Schema.String),
  seed: Schema.Finite,
  applicationId: Schema.String,
  requires: Schema.Array(Schema.String),
  topology: Schema.Struct({
    storeId: Schema.String,
    clients: Schema.Array(ClientDefinition),
  }),
  phases: Schema.Array(ScenarioPhase),
  oracles: Schema.Array(ScenarioOracle),
})
export type ScenarioAst = typeof ScenarioAst.Type

export const HostCapabilities = Schema.Struct({
  profile: ParticipantProfile,
  capabilities: Schema.Array(Schema.String),
  maximumSessionsPerClient: Schema.Finite,
  settlement: Schema.Literal('stable-poll'),
})
export type HostCapabilities = typeof HostCapabilities.Type

export const CreateClientCommand = Schema.Struct({
  operationId: Schema.String,
  storeId: Schema.String,
  client: ClientDefinition,
})
export type CreateClientCommand = typeof CreateClientCommand.Type

export const DispatchActionCommand = Schema.Struct({
  operationId: Schema.String,
  target: ParticipantRef,
  action: Schema.String,
  input: Schema.Json,
})
export type DispatchActionCommand = typeof DispatchActionCommand.Type

export const SetConnectivityCommand = Schema.Struct({
  operationId: Schema.String,
  clientId: Schema.String,
  connected: Schema.Boolean,
})
export type SetConnectivityCommand = typeof SetConnectivityCommand.Type

export const SessionLifecycleCommand = Schema.Struct({
  operationId: Schema.String,
  target: ParticipantRef,
})
export type SessionLifecycleCommand = typeof SessionLifecycleCommand.Type

export const ClientLifecycleCommand = Schema.Struct({
  operationId: Schema.String,
  clientId: Schema.String,
})
export type ClientLifecycleCommand = typeof ClientLifecycleCommand.Type

export const InspectStateCommand = Schema.Struct({
  operationId: Schema.String,
  target: ParticipantRef,
  inspector: Schema.String,
})
export type InspectStateCommand = typeof InspectStateCommand.Type

/** Host-side request handling completed; this does not confirm backend receipt or propagation. */
export const HostAcknowledgement = Schema.Struct({
  operationId: Schema.String,
  status: Schema.Literal('acknowledged'),
})
export type HostAcknowledgement = typeof HostAcknowledgement.Type

export const SyncObservation = Schema.Struct({
  participant: ParticipantRef,
  localHead: Schema.String,
  upstreamHead: Schema.String,
  pendingCount: Schema.Finite,
  isSynced: Schema.Boolean,
})
export type SyncObservation = typeof SyncObservation.Type

export const ObservedEvent = Schema.Struct({
  eventRef: Schema.String,
  name: Schema.String,
  args: Schema.Json,
  origin: ParticipantRef,
  position: Schema.String,
  parentPosition: Schema.String,
  disposition: Schema.Literals(['pending', 'confirmed']),
})
export type ObservedEvent = typeof ObservedEvent.Type

export const ComponentSyncObservation = Schema.Struct({
  localHead: Schema.String,
  upstreamHead: Schema.String,
  pendingCount: Schema.Finite,
  events: Schema.Array(ObservedEvent),
})
export type ComponentSyncObservation = typeof ComponentSyncObservation.Type

export const BackendObservation = Schema.Struct({
  id: Schema.String,
  connected: Schema.Boolean,
  head: Schema.String,
  events: Schema.Array(ObservedEvent),
})
export type BackendObservation = typeof BackendObservation.Type

export const ParticipantClockReading = Schema.Struct({
  emitterId: Schema.String,
  localSequence: Schema.Finite,
  localMonotonicMs: Schema.Finite,
})
export type ParticipantClockReading = typeof ParticipantClockReading.Type

export const HostObservationOccurrence = Schema.Struct({
  reading: ParticipantClockReading,
  controllerBeforeMonotonicMs: Schema.Finite,
  controllerAfterMonotonicMs: Schema.Finite,
  calibrationId: Schema.String,
})
export type HostObservationOccurrence = typeof HostObservationOccurrence.Type

export const ClientSystemObservation = Schema.Struct({
  clientId: Schema.String,
  connected: Schema.Boolean,
  leader: ComponentSyncObservation,
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      sync: ComponentSyncObservation,
    }),
  ),
})
export type ClientSystemObservation = typeof ClientSystemObservation.Type

export const HostSystemObservation = Schema.Struct({
  backend: BackendObservation,
  clients: Schema.Array(ClientSystemObservation),
  occurrences: Schema.Struct({
    backend: HostObservationOccurrence,
    clients: Schema.Array(
      Schema.Struct({
        clientId: Schema.String,
        connectivity: HostObservationOccurrence,
        leader: HostObservationOccurrence,
        sessions: Schema.Array(
          Schema.Struct({
            sessionId: Schema.String,
            occurrence: HostObservationOccurrence,
          }),
        ),
      }),
    ),
  }),
})
export type HostSystemObservation = typeof HostSystemObservation.Type

export const RuntimeFailureObservation = Schema.Struct({
  clientId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  source: Schema.String,
  code: Schema.String,
  message: Schema.String,
})
export type RuntimeFailureObservation = typeof RuntimeFailureObservation.Type

export const SyncObservationPayload = Schema.Struct({
  participant: Schema.String,
  localHead: Schema.String,
  upstreamHead: Schema.String,
  pendingCount: Schema.Finite,
  isSynced: Schema.Boolean,
})
export type SyncObservationPayload = typeof SyncObservationPayload.Type

export const ScenarioTracePayload = Schema.Union([
  Schema.TaggedStruct('run.started', {
    scenarioId: Schema.String,
    applicationId: Schema.String,
    seed: Schema.Finite,
  }),
  Schema.TaggedStruct('run.failed', {
    code: Schema.String,
    message: Schema.String,
    phaseId: Schema.NullOr(Schema.String),
    stepId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('run.completed', { status: Schema.Literals(['passed', 'failed']) }),
  Schema.TaggedStruct('operation.outcome', {
    status: Schema.Literals(['definite-failure', 'indefinite']),
    code: Schema.String,
    message: Schema.String,
  }),
  Schema.TaggedStruct('client.create.requested', {
    sessions: Schema.Array(Schema.String),
    initiallyConnected: Schema.Boolean,
  }),
  Schema.TaggedStruct('client.created', { status: Schema.Literal('acknowledged') }),
  Schema.TaggedStruct('phase.started', { description: Schema.String }),
  Schema.TaggedStruct('phase.completed', {}),
  Schema.TaggedStruct('action.requested', { action: Schema.String, input: Schema.Json }),
  Schema.TaggedStruct('action.completed', {
    action: Schema.String,
    status: Schema.Literal('acknowledged'),
  }),
  Schema.TaggedStruct('connectivity.disconnect.requested', { connected: Schema.Literal(false) }),
  Schema.TaggedStruct('connectivity.reconnect.requested', { connected: Schema.Literal(true) }),
  Schema.TaggedStruct('connectivity.disconnected', { connected: Schema.Literal(false) }),
  Schema.TaggedStruct('connectivity.reconnected', { connected: Schema.Literal(true) }),
  Schema.TaggedStruct('fault.injected', {
    faultId: Schema.String,
    fault: Schema.Literal('client-disconnected'),
  }),
  Schema.TaggedStruct('fault.removed', {
    faultId: Schema.String,
    fault: Schema.Literal('client-disconnected'),
  }),
  Schema.TaggedStruct('quiescence.reached', {
    inFlightOperationIds: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('recovery.observed', {
    faultIds: Schema.Array(Schema.String),
    converged: Schema.Boolean,
    observations: Schema.Array(SyncObservationPayload),
  }),
  Schema.TaggedStruct('recovery.completed', {
    faultIds: Schema.Array(Schema.String),
    observations: Schema.Array(SyncObservationPayload),
  }),
  Schema.TaggedStruct('lifecycle.session-stop.requested', {}),
  Schema.TaggedStruct('lifecycle.session-stopped', {}),
  Schema.TaggedStruct('lifecycle.session-restart.requested', {}),
  Schema.TaggedStruct('lifecycle.session-restarted', {}),
  Schema.TaggedStruct('lifecycle.client-restart.requested', {}),
  Schema.TaggedStruct('lifecycle.client-restarted', {}),
  Schema.TaggedStruct('settlement.requested', {
    participants: Schema.Array(Schema.String),
    healDisconnectedClients: Schema.Array(Schema.String),
    timeoutMs: Schema.Finite,
  }),
  Schema.TaggedStruct('settlement.progress', {
    settled: Schema.Boolean,
    observations: Schema.Array(SyncObservationPayload),
  }),
  Schema.TaggedStruct('settlement.failed', {
    code: Schema.String,
    message: Schema.String,
    timeoutMs: Schema.Finite,
    observations: Schema.Array(SyncObservationPayload),
  }),
  Schema.TaggedStruct('runtime.failure.observed', {
    source: Schema.String,
    code: Schema.String,
    message: Schema.String,
  }),
  Schema.TaggedStruct('settlement.completed', { observations: Schema.Array(SyncObservationPayload) }),
  Schema.TaggedStruct('sync.snapshot', SyncObservationPayload.fields),
  Schema.TaggedStruct('state.snapshot', { inspector: Schema.String, value: Schema.Json }),
  Schema.TaggedStruct('backend.observed', { reason: Schema.String, observation: BackendObservation }),
  Schema.TaggedStruct('client.connectivity.observed', {
    reason: Schema.String,
    connected: Schema.Boolean,
  }),
  Schema.TaggedStruct('leader.sync.observed', {
    reason: Schema.String,
    observation: ComponentSyncObservation,
  }),
  Schema.TaggedStruct('session.sync.observed', {
    reason: Schema.String,
    observation: ComponentSyncObservation,
  }),
  Schema.TaggedStruct('oracle.verdict', {
    oracleId: Schema.String,
    oracle: Schema.String,
    status: Schema.Literals(['passed', 'failed']),
    summary: Schema.String,
    evidence: Schema.Array(Schema.Finite),
  }),
])
export type ScenarioTracePayload = typeof ScenarioTracePayload.Type

export const TraceEvidenceSemantics = Schema.Literals([
  'controller-event',
  'instruction-sent',
  'acknowledgement-received',
  'first-observed',
  'verdict',
])
export type TraceEvidenceSemantics = typeof TraceEvidenceSemantics.Type

export const CalibratedScenarioTime = Schema.Struct({
  earliestMs: Schema.Finite,
  latestMs: Schema.Finite,
  calibrationId: Schema.String,
})
export type CalibratedScenarioTime = typeof CalibratedScenarioTime.Type

export const ScenarioTraceRecord = Schema.Struct({
  traceVersion: Schema.Literal(scenarioTraceVersion),
  runId: Schema.String,
  index: Schema.Finite,
  origin: Schema.Literals(['instruction', 'acknowledgement', 'observation', 'verdict']),
  correlationId: Schema.NullOr(Schema.String),
  causationId: Schema.NullOr(Schema.String),
  clientId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  phaseId: Schema.NullOr(Schema.String),
  logicalTime: Schema.Finite,
  wallTimeMs: Schema.Finite,
  captureId: Schema.NullOr(Schema.String),
  evidence: TraceEvidenceSemantics,
  emitterId: Schema.String,
  localSequence: Schema.Finite,
  localMonotonicMs: Schema.Finite,
  coordinatorReceiptMonotonicMs: Schema.Finite,
  calibratedTime: Schema.NullOr(CalibratedScenarioTime),
  causedBy: Schema.Array(Schema.Finite),
  payload: ScenarioTracePayload,
})
export type ScenarioTraceRecord = typeof ScenarioTraceRecord.Type

export const OracleVerdict = Schema.Struct({
  oracleId: Schema.String,
  oracle: Schema.String,
  status: Schema.Literals(['passed', 'failed']),
  summary: Schema.String,
  evidence: Schema.Array(Schema.Finite),
})
export type OracleVerdict = typeof OracleVerdict.Type

export const ParticipantSnapshot = Schema.Struct({
  participant: ParticipantRef,
  sync: SyncObservation,
  state: Schema.Record(Schema.String, Schema.Json),
})
export type ParticipantSnapshot = typeof ParticipantSnapshot.Type

export const ScenarioRunArtifact = Schema.Struct({
  artifactVersion: Schema.Literal(scenarioArtifactVersion),
  descriptor: Schema.Struct({
    runId: Schema.String,
    scenarioId: Schema.String,
    scenarioVersion: Schema.Finite,
    traceVersion: Schema.Finite,
    applicationId: Schema.String,
    sourceRevision: Schema.String,
    seed: Schema.Finite,
    reproductionMode: Schema.Literal('seeded'),
    execution: ExecutionConfiguration,
    capabilities: HostCapabilities,
    componentVersions: Schema.Record(Schema.String, Schema.String),
  }),
  scenario: ScenarioAst,
  trace: Schema.Array(ScenarioTraceRecord),
  verdicts: Schema.Array(OracleVerdict),
  snapshots: Schema.Array(ParticipantSnapshot),
  status: Schema.Literals(['passed', 'failed']),
})
export type ScenarioRunArtifact = typeof ScenarioRunArtifact.Type

export class ScenarioValidationError extends Error {
  readonly _tag = 'ScenarioValidationError'

  constructor(message: string) {
    super(message)
    this.name = 'ScenarioValidationError'
  }
}

/** Validates both the wire shape and the cross-reference invariants of a scenario. */
export const defineScenario = (input: unknown): ScenarioAst => {
  let scenario: ScenarioAst
  try {
    scenario = Schema.decodeUnknownSync(ScenarioAst)(input)
  } catch (cause) {
    throw new ScenarioValidationError(`Invalid scenario AST: ${String(cause)}`)
  }

  const clientIds = new Set<string>()
  const participants = new Set<string>()
  for (const client of scenario.topology.clients) {
    if (clientIds.has(client.id) === true) throw new ScenarioValidationError(`Duplicate Client id: ${client.id}`)
    clientIds.add(client.id)
    if (client.sessions.length === 0) {
      throw new ScenarioValidationError(`Client ${client.id} must declare at least one session`)
    }
    for (const sessionId of client.sessions) {
      const key = participantKey({ clientId: client.id, sessionId })
      if (participants.has(key) === true) throw new ScenarioValidationError(`Duplicate participant: ${key}`)
      participants.add(key)
    }
  }

  const assertClient = (clientId: string) => {
    if (clientIds.has(clientId) === false) throw new ScenarioValidationError(`Unknown Client reference: ${clientId}`)
  }
  const assertParticipant = (participant: ParticipantRef) => {
    const key = participantKey(participant)
    if (participants.has(key) === false) throw new ScenarioValidationError(`Unknown participant reference: ${key}`)
  }

  const stepIds = new Set<string>()
  for (const phase of scenario.phases) {
    for (const step of phase.steps) {
      if (stepIds.has(step.id) === true) throw new ScenarioValidationError(`Duplicate step id: ${step.id}`)
      stepIds.add(step.id)
      if (step._tag === 'action') assertParticipant(step.target)
      if (step._tag === 'stop-session' || step._tag === 'restart-session') assertParticipant(step.target)
      if (step._tag === 'restart-client') assertClient(step.clientId)
      if (step._tag === 'disconnect' || step._tag === 'reconnect') assertClient(step.clientId)
      if (step._tag === 'settle') {
        if (step.timeoutMs <= 0) throw new ScenarioValidationError(`Settle timeout must be positive: ${step.id}`)
        step.participants.forEach(assertParticipant)
        step.healDisconnectedClients.forEach(assertClient)
      }
    }
  }

  for (const oracle of scenario.oracles) oracle.participants.forEach(assertParticipant)
  return scenario
}

export const participantKey = ({ clientId, sessionId }: ParticipantRef): string => `${clientId}/${sessionId}`
