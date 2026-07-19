import { Schema } from '@livestore/utils/effect'

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

export const SettleStep = Schema.TaggedStruct('settle', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
  healDisconnectedClients: Schema.Array(Schema.String),
  timeoutMs: Schema.Finite,
})

export const ScenarioStep = Schema.Union([ActionStep, DisconnectStep, ReconnectStep, SettleStep])
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
  execution: Schema.Struct({
    participantProfile: Schema.Literal('in-process'),
    syncBackend: Schema.Literal('mock'),
    stateProfile: Schema.Literal('sqlite'),
    requires: Schema.Array(Schema.String),
  }),
  topology: Schema.Struct({
    storeId: Schema.String,
    clients: Schema.Array(ClientDefinition),
  }),
  phases: Schema.Array(ScenarioPhase),
  oracles: Schema.Array(ScenarioOracle),
})
export type ScenarioAst = typeof ScenarioAst.Type

export const HostCapabilities = Schema.Struct({
  profile: Schema.Literal('in-process'),
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

export const InspectStateCommand = Schema.Struct({
  operationId: Schema.String,
  target: ParticipantRef,
  inspector: Schema.String,
})
export type InspectStateCommand = typeof InspectStateCommand.Type

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

export const ScenarioTraceRecord = Schema.Struct({
  traceVersion: Schema.Literal(1),
  runId: Schema.String,
  index: Schema.Finite,
  origin: Schema.Literals(['instruction', 'acknowledgement', 'observation', 'verdict']),
  kind: Schema.String,
  correlationId: Schema.NullOr(Schema.String),
  causationId: Schema.NullOr(Schema.String),
  clientId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  phaseId: Schema.NullOr(Schema.String),
  logicalTime: Schema.Finite,
  wallTimeMs: Schema.Finite,
  payload: Schema.Json,
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
  artifactVersion: Schema.Literal(1),
  descriptor: Schema.Struct({
    runId: Schema.String,
    scenarioId: Schema.String,
    scenarioVersion: Schema.Finite,
    traceVersion: Schema.Finite,
    applicationId: Schema.String,
    sourceRevision: Schema.String,
    seed: Schema.Finite,
    reproductionMode: Schema.Literal('seeded'),
    execution: ScenarioAst.fields.execution,
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
