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
  Schema.TaggedStruct('workload.requested', {
    workload: Schema.String,
    input: Schema.Json,
    targets: Schema.Array(Schema.String),
    count: Schema.Int,
    seed: Schema.Finite,
  }),
  Schema.TaggedStruct('workload.completed', {
    workload: Schema.String,
    actionIds: Schema.Array(Schema.String),
    status: Schema.Literal('acknowledged'),
  }),
  Schema.TaggedStruct('connectivity.disconnect.requested', { connected: Schema.Literal(false) }),
  Schema.TaggedStruct('connectivity.reconnect.requested', { connected: Schema.Literal(true) }),
  Schema.TaggedStruct('connectivity.disconnected', { connected: Schema.Literal(false) }),
  Schema.TaggedStruct('connectivity.reconnected', { connected: Schema.Literal(true) }),
  Schema.TaggedStruct('backend.availability.requested', { available: Schema.Boolean }),
  Schema.TaggedStruct('backend.availability.changed', { available: Schema.Boolean }),
  Schema.TaggedStruct('fault.injected', {
    faultId: Schema.String,
    fault: Schema.Literals(['client-disconnected', 'backend-unavailable']),
  }),
  Schema.TaggedStruct('fault.removed', {
    faultId: Schema.String,
    fault: Schema.Literals(['client-disconnected', 'backend-unavailable']),
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
  Schema.TaggedStruct('lifecycle.session-add.requested', {}),
  Schema.TaggedStruct('lifecycle.session-added', {}),
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
import { Schema } from '@livestore/utils/effect'

import { HostCapabilities } from './host-protocol.ts'
import { BackendObservation, ComponentSyncObservation, SyncObservation, SyncObservationPayload } from './observations.ts'
import {
  ExecutionConfiguration,
  ParticipantRef,
  ScenarioAst,
  scenarioArtifactVersion,
  scenarioTraceVersion,
} from './scenario.ts'

