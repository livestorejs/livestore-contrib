import type { Schema } from '@livestore/utils/effect'

import type { ComponentSyncObservation, ParticipantClockReading, ParticipantRef, SyncObservation } from '../model.ts'

export interface BrowserStartOptions {
  readonly storeId: string
  readonly clientId: string
  readonly sessionId: string
}

export interface BrowserPageObservation {
  readonly leader: ComponentSyncObservation
  readonly session: ComponentSyncObservation
  readonly sync: SyncObservation
  readonly clock: ParticipantClockReading
}

export interface ScenarioBrowserControl {
  readonly start: (options: BrowserStartOptions) => Promise<void>
  readonly dispatchAction: (args: { target: ParticipantRef; action: string; input: Schema.Json }) => Promise<void>
  readonly observe: () => Promise<BrowserPageObservation>
  readonly inspectState: (args: { participant: ParticipantRef; inspector: string }) => Promise<Schema.Json>
  readonly shutdown: () => Promise<void>
}

declare global {
  interface Window {
    __scenarioBrowser: ScenarioBrowserControl
  }
}
