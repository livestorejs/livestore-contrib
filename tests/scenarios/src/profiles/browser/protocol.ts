import type { Schema } from '@livestore/utils/effect'

import type { ComponentSyncObservation, ParticipantClockReading, ParticipantRef, SyncObservation } from '../../model.ts'

export interface BrowserStartOptions {
  readonly applicationId: string
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

/**
 * Main-thread frame timing since the previous drain. Times are milliseconds relative to the drain (negative means
 * earlier), so the host can place them on the controller clock with the drain's calibrated round trip.
 */
export interface BrowserFrameTiming {
  /** Page time covered since the previous drain. */
  readonly windowMs: number
  /** Animation frames completed in the window. */
  readonly frameCount: number
  /** Frames slower than 20 ms as `[start, gap]`. */
  readonly slowFrames: ReadonlyArray<readonly [number, number]>
  /** Chromium long animation frames as `[start, duration, blockingDuration, longest scripts]`. */
  readonly longAnimationFrames: ReadonlyArray<readonly [number, number, number, string]>
  /** Intervals in which the harness drove the page, as `[start, duration, label]`. */
  readonly harnessIntervals: ReadonlyArray<readonly [number, number, string]>
  readonly longAnimationFramesSupported: boolean
}

export interface BrowserFrameTimingDrain {
  readonly timing: BrowserFrameTiming
  readonly clock: ParticipantClockReading
}

export interface BrowserDatabaseDiagnostics {
  readonly sessionStateBase64: string
  readonly leaderStateBase64: string
  readonly eventlogBase64: string
  readonly syncStates: { readonly session: unknown; readonly leader: unknown }
}

export interface ScenarioBrowserControl {
  readonly start: (options: BrowserStartOptions) => Promise<void>
  readonly setConnectivity: (connected: boolean) => Promise<void>
  readonly captureDatabaseDiagnostics: () => Promise<BrowserDatabaseDiagnostics>
  readonly dispatchAction: (args: { target: ParticipantRef; action: string; input: Schema.Json }) => Promise<void>
  readonly observe: () => Promise<BrowserPageObservation>
  readonly inspectState: (args: { participant: ParticipantRef; inspector: string }) => Promise<Schema.Json>
  readonly drainFrameTiming: () => Promise<BrowserFrameTimingDrain>
  readonly shutdown: () => Promise<void>
}

declare global {
  interface Window {
    __scenarioBrowser: ScenarioBrowserControl
  }
}
