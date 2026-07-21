import { expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect, Exit, Schema } from '@livestore/utils/effect'

import { makeMockScenarioBackend } from './backends.ts'
import { browserMultiSessionRecovery } from './corpus/browser-multi-session-recovery.ts'
import { offlineWriterRecovery } from './corpus/offline-writer-recovery.ts'
import { sharedTodoWorkday } from './corpus/shared-todo-workday.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { makeInProcessHost } from './host.ts'
import { defineScenario, ScenarioRunArtifact } from './model.ts'
import {
  deriveAdaptiveTimeLayout,
  deriveEventTimeline,
  deriveExplicitCausalEdges,
  derivePlaybackMoments,
  deriveTraceCaptures,
  projectAdaptiveTime,
  projectTraceAt,
} from './projection.ts'
import {
  runBrowserLocalSyncCfScenario,
  runInProcessLocalSyncCfScenario,
  runInProcessScenario,
  runProcessLocalSyncCfScenario,
} from './runner.ts'

/** Verifies: LS.SYS.VER.SCEN-R01, LS.SYS.VER.SCEN-R03, LS.SYS.VER.SCEN-R06 */
Vitest.describe('scenario model', () => {
  Vitest.it('validates and round-trips the versioned serializable AST', () => {
    const encoded = JSON.parse(JSON.stringify(offlineWriterRecovery))
    expect(defineScenario(encoded)).toEqual(offlineWriterRecovery)
  })

  Vitest.it('expands the shared workday into exactly 100 mixed application actions', () => {
    const actionSteps = sharedTodoWorkday.phases
      .flatMap((phase) => phase.steps)
      .filter((step) => step._tag === 'action')

    expect(actionSteps).toHaveLength(100)
    expect(new Set(actionSteps.map((step) => step.action))).toEqual(
      new Set(['createTodo', 'editTodo', 'setTodoCompleted', 'deleteTodo']),
    )
    expect(
      Object.fromEntries(
        [...Map.groupBy(actionSteps, (step) => step.action).entries()].map(([key, value]) => [key, value.length]),
      ),
    ).toEqual({
      createTodo: 30,
      editTodo: 28,
      setTodoCompleted: 32,
      deleteTodo: 10,
    })
    const completionInput = Schema.Struct({ id: Schema.String, completed: Schema.Boolean })
    expect(
      actionSteps
        .filter((step) => step.action === 'setTodoCompleted')
        .map((step) => Schema.decodeUnknownSync(completionInput)(step.input).completed)
        .filter((completed) => completed === false),
    ).toHaveLength(8)
    expect(sharedTodoWorkday.topology.clients).toHaveLength(3)
  })
})

Vitest.describe('elapsed-time projection', () => {
  Vitest.it('compresses long gaps while preserving and exposing their real duration', () => {
    const layout = deriveAdaptiveTimeLayout([0, 50, 100, 3_100, 3_150], {
      compressionThresholdMs: 500,
      compressedGapWidthMs: 100,
    })

    expect(layout.compressedGaps).toEqual([expect.objectContaining({ startMs: 100, endMs: 3_100, durationMs: 3_000 })])
    expect(projectAdaptiveTime(layout, 50)).toBeCloseTo(0.2)
    expect(projectAdaptiveTime(layout, 3_100)).toBeCloseTo(0.8)
    expect(layout.points.map((point) => point.position)).toEqual(
      layout.points.map((point) => point.position).toSorted((left, right) => left - right),
    )
  })

  Vitest.it('keeps an entirely short time range linear', () => {
    const layout = deriveAdaptiveTimeLayout([0, 50, 100], { compressionThresholdMs: 500 })

    expect(layout.compressedGaps).toEqual([])
    expect(projectAdaptiveTime(layout, 50)).toBe(0.5)
  })
})

/** Verifies: LS.SYS.VER.SCEN-R05, LS.SYS.VER.SCEN-R06, LS.SYS.VER.SCEN-R08 */
Vitest.describe('in-process host conformance', () => {
  Vitest.live('rejects topology beyond its advertised session capability', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      expect(host.capabilities.maximumSessionsPerClient).toBe(1)

      const exit = yield* host
        .createClient({
          operationId: 'create-client-a',
          storeId: 'host-conformance',
          client: { id: 'client-a', sessions: ['session-a', 'session-b'], initiallyConnected: true },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Vitest.withTestCtx(test)),
  )
})

/**
 * Verifies the first vertical slice of LS.SYS.VER.SCEN-R02, R04, R07, R11 to
 * R16, and R18.
 */
Vitest.describe('offline writer recovery', () => {
  Vitest.live(
    'runs through real Stores and emits passing convergence evidence',
    (test) =>
      Effect.gen(function* () {
        const artifact = yield* runInProcessScenario({
          scenario: offlineWriterRecovery,
          application: todoApplication,
          options: { runId: 'offline-writer-recovery-test', sourceRevision: 'test' },
        })

        expect(artifact.status).toBe('passed')
        expect(artifact.artifactVersion).toBe(4)
        expect(artifact.descriptor.traceVersion).toBe(3)
        expect(artifact.verdicts).toHaveLength(4)
        expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
        expect(artifact.snapshots).toHaveLength(2)
        expect(artifact.trace.map((record) => record.payload._tag)).toEqual(
          expect.arrayContaining([
            'client.created',
            'connectivity.disconnected',
            'connectivity.reconnected',
            'settlement.completed',
            'state.snapshot',
            'oracle.verdict',
          ]),
        )
        expect(() => Schema.decodeUnknownSync(ScenarioRunArtifact)(artifact)).not.toThrow()

        for (const emitterRecords of Map.groupBy(artifact.trace, (record) => record.emitterId).values()) {
          expect(
            emitterRecords.every(
              (record, index) =>
                index === 0 ||
                (record.localSequence >= emitterRecords[index - 1]!.localSequence &&
                  record.localMonotonicMs >= emitterRecords[index - 1]!.localMonotonicMs),
            ),
          ).toBe(true)
        }
        const sampledRecords = artifact.trace.filter((record) => record.evidence === 'first-observed')
        expect(sampledRecords.length).toBeGreaterThan(0)
        expect(sampledRecords.every((record) => record.captureId !== null)).toBe(true)
        const captures = deriveTraceCaptures(artifact.trace)
        expect(captures.length).toBeGreaterThan(1)
        expect(captures.every((capture) => capture.recordIndexes.length > 0)).toBe(true)
        expect(captures.some((capture) => capture.recordIndexes.length > 1)).toBe(true)

        const playbackMoments = derivePlaybackMoments({ scenario: artifact.scenario, trace: artifact.trace })
        expect(playbackMoments.length).toBeLessThan(artifact.trace.length)
        expect(playbackMoments[0]).toEqual(expect.objectContaining({ recordIndex: 0, kind: 'run' }))
        expect(playbackMoments.at(-1)).toEqual(
          expect.objectContaining({ recordIndex: artifact.trace.length - 1, kind: 'run' }),
        )
        expect(playbackMoments.some((moment) => moment.kind === 'action')).toBe(true)
        expect(playbackMoments.some((moment) => moment.kind === 'connectivity')).toBe(true)
        expect(playbackMoments.some((moment) => moment.kind === 'capture')).toBe(true)
        expect(playbackMoments.map((moment) => moment.recordIndex)).toEqual(
          playbackMoments.map((moment) => moment.recordIndex).toSorted((left, right) => left - right),
        )
        for (const moment of playbackMoments.filter((candidate) => candidate.kind === 'capture')) {
          const capture = captures.find((candidate) => candidate.captureId === moment.captureId)
          expect(moment.recordIndex).toBe(capture?.lastRecordIndex)
          expect(moment.recordIndexes).toEqual(capture?.recordIndexes)
        }

        const acknowledgementRecords = artifact.trace.filter((record) => record.origin === 'acknowledgement')
        expect(acknowledgementRecords.every((record) => record.causedBy.length === 1)).toBe(true)
        const causalEdges = deriveExplicitCausalEdges(artifact.trace)
        expect(causalEdges).toHaveLength(acknowledgementRecords.length)
        expect(causalEdges.every((edge) => artifact.trace[edge.toRecordIndex]?.origin === 'acknowledgement')).toBe(true)

        const finalProjection = projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: artifact.trace.length - 1,
        })
        expect(finalProjection.runStatus).toBe('passed')
        expect(finalProjection.backend?.events).toHaveLength(2)
        expect(finalProjection.clients.every((client) => client.leader?.pendingCount === 0)).toBe(true)
        expect(finalProjection.clients.every((client) => client.leader?.events.length === 2)).toBe(true)

        const backendRefs = finalProjection.backend?.events.map((event) => event.eventRef).toSorted()
        for (const client of finalProjection.clients) {
          expect(client.leader?.events.map((event) => event.eventRef).toSorted()).toEqual(backendRefs)
          expect(client.sessions[0]?.sync?.events.map((event) => event.eventRef).toSorted()).toEqual(backendRefs)
        }

        const offlineCursor = artifact.trace.findLast(
          (record) =>
            record.clientId === 'client-a' &&
            record.payload._tag === 'leader.sync.observed' &&
            record.payload.reason === 'client-a-offline-write',
        )
        expect(offlineCursor).toBeDefined()
        const offlineProjection = projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: offlineCursor!.index,
        })
        const offlineClient = offlineProjection.clients.find((client) => client.clientId === 'client-a')
        expect(offlineClient?.connected).toBe(false)

        const markers = deriveEventTimeline(artifact.trace)
        expect(new Set(markers.map((marker) => marker.event.eventRef))).toEqual(new Set(backendRefs))
        expect(markers.some((marker) => marker.event.disposition === 'pending')).toBe(true)
        const rebasedRef = markers.find((marker) => marker.event.position.includes('r'))?.event.eventRef
        expect(rebasedRef).toBeDefined()
        expect(
          new Set(
            markers.filter((marker) => marker.event.eventRef === rebasedRef).map((marker) => marker.event.position),
          ).size,
        ).toBeGreaterThan(1)
      }).pipe(Vitest.withTestCtx(test)),
    15_000,
  )
})

/** Verifies the local-concrete backend realization independently of participant placement. */
Vitest.describe('local sync-cf backend', () => {
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

/** Verifies the worker/process participant profile against the same portable scenario. */
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
        })
        expect(artifact.descriptor.capabilities.capabilities).toContain('process-isolation')
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

/** Verifies the persisted web topology, browser network boundary, and lifecycle controls. */
Vitest.describe('browser profile', () => {
  Vitest.live(
    'runs offline writer recovery through isolated browser Clients and local sync-cf',
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
        })
        expect(artifact.descriptor.capabilities.capabilities).toContain('browser-shared-worker')
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
        expect(artifact.trace.map((record) => record.payload._tag)).toEqual(
          expect.arrayContaining([
            'lifecycle.session-stopped',
            'lifecycle.session-restarted',
            'lifecycle.client-restarted',
          ]),
        )
        expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
      }).pipe(Vitest.withTestCtx(test)),
    180_000,
  )
})
