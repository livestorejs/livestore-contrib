import { expectOfflineEventCorrelationLifecycle } from '../../test-support/runner-assertions.ts'
/** Verifies the persisted web topology, browser network boundary, and lifecycle controls. */
import {
  Effect,
  Vitest,
  expect,
  offlineWriterRecovery,
  runProcessLocalSyncCfScenario,
  todoApplication,
} from '../../test-support/scenario-test-kit.ts'

Vitest.describe('process profile', () => {
  Vitest.live(
    'runs one isolated Node process per Client against local sync-cf',
    (test) =>
      Effect.gen(function* () {
        const artifact = yield* runProcessLocalSyncCfScenario({
          scenario: offlineWriterRecovery,
          applicationId: todoApplication.id,
          options: { runId: 'offline-writer-recovery-process', sourceRevision: 'test' },
        })

        expect(artifact.status).toBe('passed')
        expect(artifact.descriptor.execution).toEqual({
          participantProfile: 'process',
          syncBackend: 'local-sync-cf',
          stateProfile: 'sqlite',
          stabilizationTimeoutMs: 60_000,
        })
        expect(artifact.descriptor.capabilities.capabilities).toContain('process-isolation')
        expectOfflineEventCorrelationLifecycle(artifact)
        expect(artifact.descriptor.componentVersions.node).toBe(process.version)
        expect(artifact.snapshots).toHaveLength(2)
        const participantRecords = artifact.trace.filter((record) => record.emitterId.startsWith('process-client:'))
        expect(participantRecords.length).toBeGreaterThan(0)
        expect(
          participantRecords.some(
            (record) =>
              record.calibratedTime !== null && record.calibratedTime.latestMs > record.calibratedTime.earliestMs,
          ),
        ).toBe(true)
      }).pipe(Vitest.withTestCtx(test)),
    90_000,
  )
})
