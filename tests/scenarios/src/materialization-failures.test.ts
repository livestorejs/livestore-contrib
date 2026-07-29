import {
  Effect,
  Vitest,
  concurrentDecrementRebase,
  expect,
  runInProcessScenario,
  todoApplication,
} from './test-support/scenario-test-kit.ts'

Vitest.describe('materialization failure scenarios', () => {
  Vitest.live('reproduces a non-negative constraint failure after concurrent decrement rebase', (test) =>
    Effect.gen(function* () {
      const artifact = yield* runInProcessScenario({
        scenario: concurrentDecrementRebase,
        application: todoApplication,
        options: { runId: 'concurrent-decrement-rebase-test', sourceRevision: 'test' },
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
          message: expect.stringContaining('CHECK constraint failed: room_availability.available_nonnegative'),
        }),
      )
      expect(runtimeFailure).toEqual(expect.objectContaining({ clientId: 'client-a', sessionId: 'session-a' }))

      const backendAtReconnect = artifact.trace.find(
        (record) => record.payload._tag === 'backend.observed' && record.payload.reason === 'reconnect-client-a',
      )
      expect(backendAtReconnect?.payload).toEqual(
        expect.objectContaining({
          _tag: 'backend.observed',
          observation: expect.objectContaining({
            events: [
              expect.objectContaining({
                name: 'v1.RoomAvailabilityInitialized',
                origin: expect.objectContaining({ clientId: 'client-b' }),
              }),
              expect.objectContaining({
                name: 'v1.AvailableRoomDecremented',
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
          phaseId: 'rebase-invalid-pending-event',
        }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )
})
