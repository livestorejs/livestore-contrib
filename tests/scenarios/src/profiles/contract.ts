import type { UnknownError } from '@livestore/common'
import type { Schema } from '@livestore/utils/effect'
import type { Effect, OtelTracer, Scope } from '@livestore/utils/effect'

import type { ScenarioOperationError } from '../application/definition.ts'
import type {
  AddSessionCommand,
  ClientLifecycleCommand,
  CreateClientCommand,
  DispatchActionCommand,
  HostAcknowledgement,
  HostCapabilities,
  HostSystemObservation,
  InspectStateCommand,
  ParticipantRef,
  RuntimeFailureObservation,
  SessionLifecycleCommand,
  SetBackendAvailabilityCommand,
  SetConnectivityCommand,
  SyncBackendRealization,
  SyncObservation,
} from '../model.ts'

export type HostError = ScenarioOperationError | UnknownError
export type HostServices = Scope.Scope | OtelTracer.OtelTracer

/** Transport-neutral interface implemented by every participant profile. */
export interface ParticipantHost {
  readonly capabilities: HostCapabilities
  readonly backendId: SyncBackendRealization
  readonly componentVersions: Readonly<Record<string, string>>
  readonly createClient: (command: CreateClientCommand) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly addSession: (command: AddSessionCommand) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly dispatchAction: (
    command: DispatchActionCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly setConnectivity: (
    command: SetConnectivityCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly setBackendAvailability: (
    command: SetBackendAvailabilityCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly stopSession: (
    command: SessionLifecycleCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly restartSession: (
    command: SessionLifecycleCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly restartClient: (
    command: ClientLifecycleCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly observeSystem: Effect.Effect<HostSystemObservation, HostError, Scope.Scope>
  readonly drainRuntimeFailures: Effect.Effect<ReadonlyArray<RuntimeFailureObservation>, HostError, Scope.Scope>
  readonly observeSync: (participant: ParticipantRef) => Effect.Effect<SyncObservation, HostError, Scope.Scope>
  readonly inspectState: (command: InspectStateCommand) => Effect.Effect<Schema.Json, HostError>
}
