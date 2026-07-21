import type { Schema } from '@livestore/utils/effect'

import type { SerializedBackendConfig } from '../backends.ts'
import type {
  ClientDefinition,
  ClientSystemObservation,
  ParticipantClockReading,
  ParticipantRef,
  SyncObservation,
} from '../model.ts'

export type ProcessClientCommand =
  | {
      readonly _tag: 'initialize'
      readonly applicationId: string
      readonly storeId: string
      readonly client: ClientDefinition
      readonly backend: SerializedBackendConfig
    }
  | {
      readonly _tag: 'dispatch-action'
      readonly target: ParticipantRef
      readonly action: string
      readonly input: Schema.Json
    }
  | { readonly _tag: 'set-connectivity'; readonly connected: boolean }
  | { readonly _tag: 'observe-client' }
  | { readonly _tag: 'observe-sync'; readonly participant: ParticipantRef }
  | { readonly _tag: 'inspect-state'; readonly participant: ParticipantRef; readonly inspector: string }
  | { readonly _tag: 'shutdown' }

export interface ProcessClientRequest {
  readonly requestId: string
  readonly command: ProcessClientCommand
}

export type ProcessClientResultPayload =
  | { readonly _tag: 'initialized'; readonly pid: number }
  | { readonly _tag: 'acknowledged' }
  | { readonly _tag: 'client-observation'; readonly observation: ClientSystemObservation }
  | { readonly _tag: 'sync-observation'; readonly observation: SyncObservation }
  | { readonly _tag: 'state'; readonly value: Schema.Json }

export type ProcessClientResult = ProcessClientResultPayload & { readonly clock: ParticipantClockReading }

export type ProcessClientResponse =
  | { readonly requestId: string; readonly status: 'success'; readonly result: ProcessClientResult }
  | { readonly requestId: string; readonly status: 'failure'; readonly error: string }
