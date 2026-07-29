import { Schema } from '@livestore/utils/effect'

import { ClientDefinition, HostCapability, ParticipantProfile, ParticipantRef } from './scenario.ts'

export const HostCapabilities = Schema.Struct({
  profile: ParticipantProfile,
  capabilities: Schema.Array(HostCapability),
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

export const AddSessionCommand = Schema.Struct({
  operationId: Schema.String,
  target: ParticipantRef,
})
export type AddSessionCommand = typeof AddSessionCommand.Type

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

export const SetBackendAvailabilityCommand = Schema.Struct({
  operationId: Schema.String,
  available: Schema.Boolean,
})
export type SetBackendAvailabilityCommand = typeof SetBackendAvailabilityCommand.Type

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
