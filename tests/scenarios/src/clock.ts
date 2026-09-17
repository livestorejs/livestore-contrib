import type { HostObservationOccurrence, ParticipantClockReading } from './model.ts'

export interface ParticipantClock {
  readonly read: () => ParticipantClockReading
}

/** Creates a participant-local monotonic clock without assuming shared origins across processes. */
export const makeParticipantClock = (emitterId: string): ParticipantClock => {
  const startedAt = performance.now()
  let localSequence = 0
  return {
    read: () => ({
      emitterId,
      localSequence: localSequence++,
      localMonotonicMs: performance.now() - startedAt,
    }),
  }
}

/** Retains the complete controller round-trip as the uncertainty interval for a remote reading. */
export const calibrateParticipantReading = (args: {
  reading: ParticipantClockReading
  controllerBeforeMonotonicMs: number
  controllerAfterMonotonicMs: number
  calibrationId: string
}): HostObservationOccurrence => ({
  reading: args.reading,
  controllerBeforeMonotonicMs: args.controllerBeforeMonotonicMs,
  controllerAfterMonotonicMs: args.controllerAfterMonotonicMs,
  calibrationId: args.calibrationId,
})

/** Same-process evidence has no transport uncertainty and shares the controller's monotonic clock. */
export const readControllerOccurrence = (clock: ParticipantClock): HostObservationOccurrence => {
  const reading = clock.read()
  const controllerMonotonicMs = performance.now()
  return calibrateParticipantReading({
    reading,
    controllerBeforeMonotonicMs: controllerMonotonicMs,
    controllerAfterMonotonicMs: controllerMonotonicMs,
    calibrationId: `${reading.emitterId}:same-process`,
  })
}
