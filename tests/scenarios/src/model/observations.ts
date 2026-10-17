import { Schema } from '@livestore/utils/effect'

import { ParticipantRef } from './scenario.ts'

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

/**
 * Main-thread frame timing reported by a participant since its previous report. Times are milliseconds relative to the
 * report's own participant clock reading, which the occurrence calibrates onto the controller clock.
 */
export const FrameTiming = Schema.Struct({
  windowMs: Schema.Finite,
  frameCount: Schema.Finite,
  /** Frames slower than 20 ms as `[start, gap]`. */
  slowFrames: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
  /** Long animation frames as `[start, duration, blockingDuration, longest scripts]`. */
  longAnimationFrames: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.String])),
  /** Intervals in which the harness drove the participant, as `[start, duration, label]`. */
  harnessIntervals: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.String])),
  longAnimationFramesSupported: Schema.Boolean,
})
export type FrameTiming = typeof FrameTiming.Type

export interface FrameTimingObservation {
  readonly participant: ParticipantRef
  readonly occurrence: HostObservationOccurrence
  readonly timing: FrameTiming
}

export const SyncObservationPayload = Schema.Struct({
  participant: Schema.String,
  localHead: Schema.String,
  upstreamHead: Schema.String,
  pendingCount: Schema.Finite,
  isSynced: Schema.Boolean,
})
export type SyncObservationPayload = typeof SyncObservationPayload.Type
