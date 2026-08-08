import { expectOfflineEventCorrelationLifecycle } from '../../test-support/runner-assertions.ts'
import {
  Effect,
  Vitest,
  browserMultiSessionRecovery,
  expect,
  offlineWriterRecovery,
  projectTraceAt,
  runBrowserLocalSyncCfScenario,
  todoApplication,
} from '../../test-support/scenario-test-kit.ts'

Vitest.describe('browser profile', () => {
  Vitest.live(
    'runs the offline writer recovery through the browser SharedWorker topology',
    (test) =>
      Effect.gen(function* () {
        const artifact = yield* runBrowserLocalSyncCfScenario({
          scenario: offlineWriterRecovery,
          applicationId: todoApplication.id,
          options: { runId: 'offline-writer-recovery-browser', sourceRevision: 'test' },
        })

        expect(artifact.status).toBe('passed')
        expect(artifact.descriptor.execution).toEqual({
          participantProfile: 'browser',
          syncBackend: 'local-sync-cf',
          stateProfile: 'opfs',
          stabilizationTimeoutMs: 60_000,
        })
        expect(artifact.descriptor.capabilities.capabilities).toContain('browser-shared-worker')
        expectOfflineEventCorrelationLifecycle(artifact)
        expect(artifact.snapshots).toHaveLength(2)
        expect(artifact.snapshots.every((snapshot) => snapshot.sync.pendingCount === 0)).toBe(true)
        expect(artifact.trace.at(-1)?.payload).toEqual(expect.objectContaining({ _tag: 'run.completed' }))
        const participantRecords = artifact.trace.filter((record) => record.emitterId.startsWith('browser-session:'))
        expect(participantRecords.length).toBeGreaterThan(0)
        expect(
          participantRecords.some(
            (record) =>
              record.calibratedTime !== null && record.calibratedTime.latestMs > record.calibratedTime.earliestMs,
          ),
        ).toBe(true)
      }).pipe(Vitest.withTestCtx(test)),
    120_000,
  )

  Vitest.live(
    'restores two sessions through page and persistent Client restarts',
    (test) =>
      Effect.gen(function* () {
        const artifact = yield* runBrowserLocalSyncCfScenario({
          scenario: browserMultiSessionRecovery,
          applicationId: todoApplication.id,
          options: { runId: 'browser-multi-session-recovery-test', sourceRevision: 'test' },
        })

        expect(artifact.status).toBe('passed')
        expect(artifact.snapshots).toHaveLength(2)
        const sessionAdded = artifact.trace.find((record) => record.payload._tag === 'lifecycle.session-added')
        const beforeAddition = projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: (sessionAdded?.index ?? 0) - 1,
        })
        const afterAddition = projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: sessionAdded?.index ?? -1,
        })
        expect(
          beforeAddition.clients
            .find((client) => client.clientId === 'client-a')
            ?.sessions.find((session) => session.sessionId === 'session-a2')?.lifecycle,
        ).toBe('declared')
        expect(
          afterAddition.clients
            .find((client) => client.clientId === 'client-a')
            ?.sessions.find((session) => session.sessionId === 'session-a2')?.lifecycle,
        ).toBe('created')
        const initialLeaderStopped = artifact.trace.find(
          (record) =>
            record.clientId === 'client-a' &&
            record.sessionId === 'session-a1' &&
            record.payload._tag === 'lifecycle.session-stopped',
        )
        const successorWrite = artifact.trace.find(
          (record) =>
            record.clientId === 'client-a' &&
            record.sessionId === 'session-a2' &&
            record.payload._tag === 'action.requested' &&
            typeof record.payload.input === 'object' &&
            record.payload.input !== null &&
            'id' in record.payload.input &&
            record.payload.input.id === 'todo-after-leader-turnover',
        )
        const initialLeaderRestarted = artifact.trace.find(
          (record) =>
            record.clientId === 'client-a' &&
            record.sessionId === 'session-a1' &&
            record.payload._tag === 'lifecycle.session-restarted',
        )
        expect(initialLeaderStopped?.index).toBeLessThan(successorWrite?.index ?? -1)
        expect(successorWrite?.index).toBeLessThan(initialLeaderRestarted?.index ?? -1)
        const eventlogVerdict = artifact.verdicts.find((verdict) => verdict.oracle === 'eventlog-convergence')
        expect(eventlogVerdict).toEqual(expect.objectContaining({ status: 'passed' }))
        expect(artifact.trace.map((record) => record.payload._tag)).toEqual(
          expect.arrayContaining([
            'lifecycle.session-stopped',
            'lifecycle.session-restarted',
            'lifecycle.session-added',
            'lifecycle.client-restarted',
          ]),
        )
        expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
      }).pipe(Vitest.withTestCtx(test)),
    180_000,
  )
})
