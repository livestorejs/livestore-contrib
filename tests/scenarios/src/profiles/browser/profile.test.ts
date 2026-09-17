import { FetchHttpClient, Layer } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeLocalSyncCfScenarioBackend } from '../../backends.ts'
import { todo } from '../../corpus/applications/todo.ts'
import { Scenario, client, normalizeScenario, stopSession } from '../../scenario.ts'
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
import { makeBrowserHost } from './host.ts'

const makeLocalBackend = makeLocalSyncCfScenarioBackend.pipe(
  Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
)

Vitest.describe('browser profile', () => {
  Vitest.live(
    'keeps a restarted session offline until its Client reconnects',
    (test) =>
      Effect.gen(function* () {
        const backend = yield* makeLocalBackend
        const host = yield* makeBrowserHost({ applicationId: todoApplication.id, backend })
        const storeId = 'browser-offline-session-restart'
        const target = { clientId: 'client-a', sessionId: 'session-a' }

        yield* host.createClient({
          operationId: 'create-client-a',
          storeId,
          client: { id: target.clientId, sessions: [target.sessionId], initiallyConnected: false },
        })
        yield* host.dispatchAction({
          operationId: 'write-offline',
          target,
          action: 'createTodo',
          input: { id: 'offline-restart', text: 'Must remain pending across restart' },
        })
        expect((yield* backend.observe(storeId)).events).toEqual([])

        yield* host.stopSession({ operationId: 'stop-session-a', target })
        yield* host.restartSession({ operationId: 'restart-session-a', target })

        expect((yield* backend.observe(storeId)).events).toEqual([])
      }).pipe(Vitest.withTestCtx(test)),
    120_000,
  )

  Vitest.live(
    'captures final snapshots only for sessions still running',
    (test) =>
      Effect.gen(function* () {
        const clientA = client('client-a').withSessions('session-a1', 'session-a2')
        const sessionA1 = clientA.session('session-a1')
        const scenario = normalizeScenario(
          Scenario.start({ application: todo, clients: [clientA] }).steps(stopSession(sessionA1)),
          { id: 'browser-stopped-final-session' },
        )

        const artifact = yield* runBrowserLocalSyncCfScenario({
          scenario,
          applicationId: todoApplication.id,
          options: { runId: 'browser-stopped-final-session-test', sourceRevision: 'test' },
        })

        expect(artifact.status).toBe('passed')
        expect(artifact.snapshots.map(({ participant }) => participant)).toEqual([
          { clientId: 'client-a', sessionId: 'session-a2' },
        ])
      }).pipe(Vitest.withTestCtx(test)),
    120_000,
  )

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
