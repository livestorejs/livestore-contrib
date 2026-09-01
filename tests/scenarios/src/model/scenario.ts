import { Schema } from '@livestore/utils/effect'

export const scenarioVersion = 5 as const
export const scenarioTraceVersion = 7 as const
export const scenarioArtifactVersion = 8 as const

export const ParticipantProfile = Schema.Literals(['in-process', 'process', 'browser'])
export type ParticipantProfile = typeof ParticipantProfile.Type

export const SyncBackendRealization = Schema.Literals(['mock', 'local-sync-cf', 'cloud-sync-cf'])
export type SyncBackendRealization = typeof SyncBackendRealization.Type

export const StateProfile = Schema.Literals(['sqlite', 'opfs'])
export type StateProfile = typeof StateProfile.Type

/** Behaviors that a Scenario may require from its participant host. */
export const HostCapability = Schema.Literals([
  'multiple-clients',
  'multiple-sessions',
  'named-actions',
  'disconnect-reconnect',
  'backend-availability',
  'sync-observation',
  'system-observation',
  'state-inspection',
  'sqlite-state',
  'opfs-state',
  'session-restart',
  'client-restart',
  'dynamic-client-creation',
  'dynamic-session-addition',
  'process-isolation',
  'browser-shared-worker',
  'browser-web-locks',
  'event-lineage',
])
export type HostCapability = typeof HostCapability.Type

export const ExecutionConfiguration = Schema.Struct({
  participantProfile: ParticipantProfile,
  syncBackend: SyncBackendRealization,
  stateProfile: StateProfile,
  stabilizationTimeoutMs: Schema.Finite,
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
export type ActionStep = typeof ActionStep.Type

/** A zero-effect narrative marker retained in the Scenario and trace. */
export const AnnotationInstruction = Schema.TaggedStruct('annotation', {
  id: Schema.String,
  text: Schema.String,
})
export type AnnotationInstruction = typeof AnnotationInstruction.Type

export const WaitStep = Schema.TaggedStruct('wait', {
  id: Schema.String,
  durationMs: Schema.Int,
})
export type WaitStep = typeof WaitStep.Type

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

/** Creates a new Client after the initial Scenario topology has started. */
export const CreateClientStep = Schema.TaggedStruct('create-client', {
  id: Schema.String,
  client: ClientDefinition,
})

/** Adds a new session to an already-created Client. */
export const AddSessionStep = Schema.TaggedStruct('add-session', {
  id: Schema.String,
  target: ParticipantRef,
})

export const BackendUnavailableStep = Schema.TaggedStruct('backend-unavailable', {
  id: Schema.String,
})

export const BackendAvailableStep = Schema.TaggedStruct('backend-available', {
  id: Schema.String,
})

/** A self-contained, ordered group of concrete application actions. */
export const ActionSequenceStep = Schema.TaggedStruct('action-sequence', {
  id: Schema.String,
  description: Schema.String,
  seed: Schema.Finite,
  delayBetweenActionsMs: Schema.NullOr(Schema.Int),
  actions: Schema.Array(ActionStep),
})
export type ActionSequenceStep = typeof ActionSequenceStep.Type

export const ParallelOperationStep = Schema.Union([
  ActionStep,
  DisconnectStep,
  ReconnectStep,
  StopSessionStep,
  RestartSessionStep,
  RestartClientStep,
  BackendUnavailableStep,
  BackendAvailableStep,
])
export type ParallelOperationStep = typeof ParallelOperationStep.Type

export const ParallelStep = Schema.TaggedStruct('parallel', {
  id: Schema.String,
  operations: Schema.Array(ParallelOperationStep),
})

export const SettleStep = Schema.TaggedStruct('settle', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
  healDisconnectedClients: Schema.Array(Schema.String),
})

export const ScenarioInstruction = Schema.Union([
  AnnotationInstruction,
  WaitStep,
  ActionStep,
  DisconnectStep,
  ReconnectStep,
  StopSessionStep,
  RestartSessionStep,
  RestartClientStep,
  BackendUnavailableStep,
  BackendAvailableStep,
  ActionSequenceStep,
  CreateClientStep,
  AddSessionStep,
  ParallelStep,
  SettleStep,
])
export type ScenarioInstruction = typeof ScenarioInstruction.Type

export const PendingResolutionOracle = Schema.TaggedStruct('pending-resolution', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
})

export const EventlogConvergenceOracle = Schema.TaggedStruct('eventlog-convergence', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
})

export const ConfirmedEventlogPrefixOracle = Schema.TaggedStruct('confirmed-eventlog-prefix', {
  id: Schema.String,
  participants: Schema.Array(ParticipantRef),
})
export type ConfirmedEventlogPrefixOracle = typeof ConfirmedEventlogPrefixOracle.Type

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

export const OperationHistoryOracle = Schema.TaggedStruct('operation-history', {
  id: Schema.String,
  operationIds: Schema.Array(Schema.String),
  requireOverlap: Schema.Boolean,
  allowIndefinite: Schema.Boolean,
})
export type OperationHistoryOracle = typeof OperationHistoryOracle.Type

export const ScenarioOracle = Schema.Union([
  PendingResolutionOracle,
  EventlogConvergenceOracle,
  ConfirmedEventlogPrefixOracle,
  StateConvergenceOracle,
  StateContainsIdsOracle,
  OperationHistoryOracle,
])
export type ScenarioOracle = typeof ScenarioOracle.Type

export const ScenarioAst = Schema.Struct({
  version: Schema.Literal(scenarioVersion),
  id: Schema.String,
  description: Schema.String,
  tags: Schema.Array(Schema.String),
  seed: Schema.Finite,
  applicationId: Schema.String,
  requires: Schema.Array(HostCapability),
  topology: Schema.Struct({
    storeId: Schema.String,
    clients: Schema.Array(ClientDefinition),
  }),
  instructions: Schema.Array(ScenarioInstruction),
  oracles: Schema.Array(ScenarioOracle),
})
export type ScenarioAst = typeof ScenarioAst.Type
