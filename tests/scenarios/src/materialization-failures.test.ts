import {
  Effect,
  Vitest,
  concurrentHotelBooking,
  expect,
  hotelBookingApplication,
  runInProcessScenario,
} from './test-support/scenario-test-kit.ts'

Vitest.describe('materialization failure scenarios', () => {
  Vitest.live('reproduces a non-negative constraint failure after concurrent decrement rebase', (test) =>
    Effect.gen(function* () {
      const artifact = yield* runInProcessScenario({
        scenario: concurrentHotelBooking,
        application: hotelBookingApplication,
        options: { runId: 'concurrent-hotel-booking-test', sourceRevision: 'test' },
      })

      expect(artifact.status).toBe('failed')
      expect(artifact.snapshots).toEqual([])

      const runtimeFailure = artifact.trace.find((record) => record.payload._tag === 'runtime.failure.observed')
      expect(runtimeFailure?.payload).toEqual(
        expect.objectContaining({
          _tag: 'runtime.failure.observed',
          source: 'store-shutdown',
          // The leader logs MaterializeError, but the Store shutdown boundary
          // currently wraps the session-side SQLite failure as UnknownError.
          code: 'UnknownError',
          message: expect.stringContaining('CHECK constraint failed: hotel_room_inventory.available_nonnegative'),
        }),
      )
      expect(runtimeFailure).toEqual(expect.objectContaining({ clientId: 'client-a', sessionId: 'session-a' }))

      const reconnectId = concurrentHotelBooking.instructions.find(
        (instruction) => instruction._tag === 'reconnect',
      )?.id
      const backendAtReconnect = artifact.trace.find(
        (record) => record.payload._tag === 'backend.observed' && record.payload.reason === reconnectId,
      )
      expect(backendAtReconnect?.payload).toEqual(
        expect.objectContaining({
          _tag: 'backend.observed',
          observation: expect.objectContaining({
            events: [
              expect.objectContaining({
                name: 'v1.HotelRoomInventoryInitialized',
                origin: expect.objectContaining({ clientId: 'client-b' }),
              }),
              expect.objectContaining({
                name: 'v1.HotelRoomBooked',
                origin: expect.objectContaining({ clientId: 'client-b' }),
              }),
            ],
          }),
        }),
      )
      expect(artifact.trace.at(-1)?.payload).toEqual(
        expect.objectContaining({
          _tag: 'run.failed',
          code: 'participant-runtime-failure',
          instructionId: reconnectId,
        }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )
})
