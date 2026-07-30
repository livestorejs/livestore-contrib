import { orderBackendEvents } from './backends.ts'
import { expectBackendOutageRecovery } from './test-support/runner-assertions.ts'
/** Verifies the worker/process participant profile against the same portable scenario. */
import {
  Effect,
  Vitest,
  backendOutageRecovery,
  expect,
  offlineWriterRecovery,
  runInProcessLocalSyncCfScenario,
  todoApplication,
} from './test-support/scenario-test-kit.ts'

Vitest.describe('local sync-cf backend', () => {
  Vitest.it('orders paged backend observations by authoritative global position', () => {
    expect(orderBackendEvents([{ seqNum: 302 }, { seqNum: 101 }, { seqNum: 401 }])).toEqual([
      { seqNum: 101 },
      { seqNum: 302 },
      { seqNum: 401 },
    ])
  })

  Vitest.live(
    'drops the participant route during a backend outage and recovers through the real WebSocket backend',
    (test) =>
      Effect.gen(function* () {
        const artifact = yield* runInProcessLocalSyncCfScenario({
          scenario: backendOutageRecovery,
          application: todoApplication,
          options: { runId: 'backend-outage-recovery-local-sync-cf', sourceRevision: 'test' },
        })

        expectBackendOutageRecovery(artifact)
      }).pipe(Vitest.withTestCtx(test, { timeout: 60_000 })),
    60_000,
  )

  Vitest.live(
    'runs the portable scenario through the real WebSocket and SQLite Durable Object backend',
    (test) =>
      Effect.gen(function* () {
        const artifact = yield* runInProcessLocalSyncCfScenario({
          scenario: offlineWriterRecovery,
          application: todoApplication,
          options: { runId: 'offline-writer-recovery-local-sync-cf', sourceRevision: 'test' },
        })

        expect(artifact.status).toBe('passed')
        expect(artifact.descriptor.execution).toEqual({
          participantProfile: 'in-process',
          syncBackend: 'local-sync-cf',
          stateProfile: 'sqlite',
        })
        expect(artifact.trace.some((record) => record.payload._tag === 'backend.observed')).toBe(true)
        expect(artifact.snapshots.every((snapshot) => snapshot.sync.pendingCount === 0)).toBe(true)
      }).pipe(Vitest.withTestCtx(test)),
    60_000,
  )
})
