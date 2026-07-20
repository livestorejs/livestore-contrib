import { expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect, Exit, Schema } from '@livestore/utils/effect'

import { makeMockScenarioBackend } from './backends.ts'
import { browserMultiSessionRecovery } from './corpus/browser-multi-session-recovery.ts'
import { offlineWriterRecovery } from './corpus/offline-writer-recovery.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { makeInProcessHost } from './host.ts'
import { defineScenario, ScenarioRunArtifact } from './model.ts'
import { deriveEventTimeline, projectTraceAt } from './projection.ts'
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
        expect(artifact.artifactVersion).toBe(3)
        expect(artifact.descriptor.traceVersion).toBe(2)
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
