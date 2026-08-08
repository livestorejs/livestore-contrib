import {
  expectOfflineEventCorrelationLifecycle,
  withTransientSessionEventlogMutation,
} from './test-support/runner-assertions.ts'
/** Verifies the local-concrete backend realization independently of participant placement. */
import {
  Effect,
  ScenarioRunArtifact,
  type ScenarioTraceRecord,
  Schema,
  Vitest,
  defineScenario,
  deriveConnectivityIntervals,
  deriveEventTimeline,
  deriveExplicitCausalEdges,
  deriveInFlightScenarioOperationIds,
  deriveLaneActivityIntervals,
  derivePlaybackMoments,
  deriveRuntimeFailureIntervals,
  deriveScenarioOperationHistory,
  deriveTraceCaptures,
  expect,
  makeInProcessHost,
  makeMockScenarioBackend,
  offlineWriterRecovery,
  projectTraceAt,
  runInProcessScenario,
  runScenario,
  todoApplication,
} from './test-support/scenario-test-kit.ts'

Vitest.describe('offline writer recovery', () => {
  for (const mutation of ['conflict', 'delete', 'rewrite', 'reorder'] as const) {
    Vitest.live(`rejects a transient confirmed Eventlog ${mutation} repaired before terminal capture`, (test) =>
      Effect.gen(function* () {
        const backend = yield* makeMockScenarioBackend
        const host = yield* makeInProcessHost({ application: todoApplication, backend })
        const artifact = yield* runScenario({
          scenario: offlineWriterRecovery,
          applicationId: todoApplication.id,
          host: withTransientSessionEventlogMutation(host, mutation),
          options: { runId: `transient-prefix-${mutation}-test`, sourceRevision: 'test' },
        })
        const prefixVerdict = artifact.verdicts.find(
          (candidate) => candidate.oracleId === 'confirmed-eventlogs-append-only',
        )

        expect(artifact.status).toBe('failed')
        expect(prefixVerdict).toEqual(expect.objectContaining({ status: 'failed' }))
        expect(prefixVerdict?.evidence.length).toBeGreaterThan(0)
        if (mutation === 'rewrite' || mutation === 'reorder') expect(prefixVerdict?.evidence).toHaveLength(2)
        expect(artifact.verdicts.find((candidate) => candidate.oracleId === 'eventlogs-converged')?.status).toBe(
          'passed',
        )
      }).pipe(Vitest.withTestCtx(test)),
    )
  }

  Vitest.live('coalesces one repeated encoding of the same confirmed global Event fact', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      const artifact = yield* runScenario({
        scenario: offlineWriterRecovery,
        applicationId: todoApplication.id,
        host: withTransientSessionEventlogMutation(host, 'duplicate'),
        options: { runId: 'repeated-prefix-encoding-test', sourceRevision: 'test' },
      })
      const prefixVerdict = artifact.verdicts.find(
        (candidate) => candidate.oracleId === 'confirmed-eventlogs-append-only',
      )

      expect(artifact.status).toBe('passed')
      expect(prefixVerdict).toEqual(
        expect.objectContaining({
          status: 'passed',
          summary: expect.stringContaining('coalesced 1 repeated same-position encodings'),
        }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )

  Vitest.live('fails rather than passing a component with only one retained observation', (test) =>
    Effect.gen(function* () {
      const participant = { clientId: 'client-a', sessionId: 'session-a' } as const
      const scenario = defineScenario({
        version: 3,
        id: 'insufficient-prefix-evidence',
        description: 'Creates a participant but retains no later component observation.',
        tags: ['safety'],
        seed: 1,
        applicationId: todoApplication.id,
        requires: [],
        topology: {
          storeId: 'insufficient-prefix-evidence',
          clients: [{ id: participant.clientId, sessions: [participant.sessionId], initiallyConnected: true }],
        },
        instructions: [],
        oracles: [
          { _tag: 'confirmed-eventlog-prefix', id: 'confirmed-eventlogs-append-only', participants: [participant] },
        ],
      })
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      const artifact = yield* runScenario({
        scenario,
        applicationId: todoApplication.id,
        host,
        options: { runId: 'insufficient-prefix-evidence-test', sourceRevision: 'test' },
      })
      const verdict = artifact.verdicts[0]

      expect(artifact.status).toBe('failed')
      expect(verdict).toEqual(
        expect.objectContaining({
          status: 'failed',
          summary: expect.stringContaining('expected at least two complete observations'),
        }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )

  Vitest.live('rejects equal settled heads when a participant Eventlog diverges from the backend', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      const divergentHost = {
        ...host,
        observeSystem: host.observeSystem.pipe(
          Effect.map((observation) => ({
            ...observation,
            clients: observation.clients.map((client) =>
              client.clientId === 'client-b'
                ? {
                    ...client,
                    sessions: client.sessions.map((session) => ({
                      ...session,
                      sync: {
                        ...session.sync,
                        events: session.sync.events.map((event, index) =>
                          index === 0 && event.disposition === 'confirmed'
                            ? { ...event, name: `${event.name}.divergent` }
                            : event,
                        ),
                      },
                    })),
                  }
                : client,
            ),
          })),
        ),
      }

      const artifact = yield* runScenario({
        scenario: offlineWriterRecovery,
        applicationId: todoApplication.id,
        host: divergentHost,
        options: { runId: 'divergent-eventlog-test', sourceRevision: 'test' },
      })
      const verdict = artifact.verdicts.find((candidate) => candidate.oracleId === 'eventlogs-converged')

      expect(artifact.status).toBe('failed')
      expect(verdict).toEqual(
        expect.objectContaining({
          status: 'failed',
          summary: expect.stringContaining('client-b/session-b'),
        }),
      )
      expect(verdict?.summary).toContain('position e1')
      expect(verdict?.evidence).toHaveLength(3)
    }).pipe(Vitest.withTestCtx(test)),
  )

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
        expect(artifact.artifactVersion).toBe(6)
        expect(artifact.descriptor.traceVersion).toBe(5)
        expect(artifact.verdicts).toHaveLength(6)
        expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
        expect(artifact.verdicts).toContainEqual(
          expect.objectContaining({
            oracleId: 'confirmed-eventlogs-append-only',
            status: 'passed',
            summary: expect.stringContaining('retained confirmed Eventlog transitions'),
          }),
        )
        expectOfflineEventCorrelationLifecycle(artifact)
        expect(artifact.snapshots).toHaveLength(2)
        expect(artifact.trace.map((record) => record.payload._tag)).toEqual(
          expect.arrayContaining([
            'client.created',
            'connectivity.disconnected',
            'connectivity.reconnected',
            'fault.injected',
            'fault.removed',
            'quiescence.reached',
            'recovery.observed',
            'recovery.completed',
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
        expect(playbackMoments[0]).toEqual(
          expect.objectContaining({ recordIndex: 0, kind: 'run', summary: 'Run started' }),
        )
        expect(playbackMoments.at(-1)).toEqual(
          expect.objectContaining({ recordIndex: artifact.trace.length - 1, kind: 'run' }),
        )
        expect(playbackMoments.some((moment) => moment.kind === 'action')).toBe(true)
        expect(playbackMoments.some((moment) => moment.kind === 'connectivity')).toBe(true)
        expect(playbackMoments.some((moment) => moment.kind === 'capture')).toBe(true)
        expect(playbackMoments.every((moment) => moment.summary.length > 0)).toBe(true)
        expect(
          playbackMoments
            .filter((moment) => moment.kind === 'capture')
            .some((moment) => moment.summary.includes('first observed')),
        ).toBe(true)
        expect(playbackMoments.map((moment) => moment.recordIndex)).toEqual(
          playbackMoments.map((moment) => moment.recordIndex).toSorted((left, right) => left - right),
        )
        for (const moment of playbackMoments.filter((candidate) => candidate.kind === 'capture')) {
          const capture = captures.find((candidate) => candidate.captureId === moment.captureId)
          expect(moment.recordIndex).toBe(capture?.lastRecordIndex)
          expect(moment.recordIndexes).toEqual(capture?.recordIndexes)
        }

        const laneActivityIntervals = deriveLaneActivityIntervals({
          scenario: artifact.scenario,
          trace: artifact.trace,
        })
        expect(new Set(laneActivityIntervals.map((interval) => interval.componentKey))).toEqual(
          new Set([
            'backend',
            'leader:client-a',
            'session:client-a/session-a',
            'leader:client-b',
            'session:client-b/session-b',
          ]),
        )
        expect(laneActivityIntervals.every((interval) => interval.endRecordIndex === null)).toBe(true)

        const acknowledgementRecords = artifact.trace.filter((record) => record.origin === 'acknowledgement')
        expect(acknowledgementRecords.every((record) => record.causedBy.length === 1)).toBe(true)
        const causalEdges = deriveExplicitCausalEdges(artifact.trace)
        expect(
          causalEdges.filter((edge) => artifact.trace[edge.toRecordIndex]?.origin === 'acknowledgement'),
        ).toHaveLength(acknowledgementRecords.length)
        const operationHistory = deriveScenarioOperationHistory(artifact.trace)
        expect(operationHistory.length).toBeGreaterThan(0)
        expect(operationHistory.every((operation) => operation.status === 'succeeded')).toBe(true)
        expect(
          artifact.trace
            .filter((record) => record.evidence === 'first-observed')
            .every((record) => record.causationId === null),
        ).toBe(true)

        const injectedFault = artifact.trace.find((record) => record.payload._tag === 'fault.injected')
        const removedFault = artifact.trace.find((record) => record.payload._tag === 'fault.removed')
        const quiescence = artifact.trace.find(
          (record) => record.payload._tag === 'quiescence.reached' && record.correlationId === 'settle-after-reconnect',
        )
        const recoveryObservations = artifact.trace.filter((record) => record.payload._tag === 'recovery.observed')
        const recoveryCompleted = artifact.trace.find((record) => record.payload._tag === 'recovery.completed')
        const settlementCompleted = artifact.trace.find(
          (record) =>
            record.payload._tag === 'settlement.completed' && record.correlationId === 'settle-after-reconnect',
        )
        expect(injectedFault?.payload).toEqual(
          expect.objectContaining({ faultId: 'disconnect-client-a', fault: 'client-disconnected' }),
        )
        expect(removedFault?.payload).toEqual(
          expect.objectContaining({ faultId: 'disconnect-client-a', fault: 'client-disconnected' }),
        )
        expect(quiescence?.payload).toEqual(expect.objectContaining({ inFlightOperationIds: [] }))
        expect(
          deriveInFlightScenarioOperationIds(artifact.trace.slice(0, (quiescence?.index ?? -1) + 1), [
            'settle-after-reconnect',
          ]),
        ).toEqual([])
        expect(recoveryObservations.length).toBeGreaterThan(0)
        expect(recoveryObservations.at(-1)?.payload).toEqual(expect.objectContaining({ converged: true }))
        expect(recoveryCompleted?.index).toBeLessThan(settlementCompleted?.index ?? 0)
        expect(injectedFault?.index).toBeLessThan(removedFault?.index ?? 0)
        expect(removedFault?.index).toBeLessThan(recoveryCompleted?.index ?? 0)

        const finalProjection = projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: artifact.trace.length - 1,
        })
        expect(finalProjection.runStatus).toBe('passed')
        expect(finalProjection.clients.every((client) => client.health === 'healthy')).toBe(true)
        expect(
          finalProjection.clients.flatMap((client) => client.sessions).every((session) => session.health === 'healthy'),
        ).toBe(true)
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
            record.payload.reason === 'concurrent-writes',
        )
        expect(offlineCursor).toBeDefined()
        const offlineProjection = projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: offlineCursor!.index,
        })
        const offlineClient = offlineProjection.clients.find((client) => client.clientId === 'client-a')
        expect(offlineClient?.connected).toBe(false)

        const connectivityIntervals = deriveConnectivityIntervals(artifact.trace)
        expect(connectivityIntervals).toEqual([
          {
            clientId: 'client-a',
            startRecordIndex: expect.any(Number),
            endRecordIndex: expect.any(Number),
            startEvidence: 'explicit-transition',
            endEvidence: 'explicit-transition',
          },
        ])
        expect(connectivityIntervals[0]!.startRecordIndex).toBeLessThan(connectivityIntervals[0]!.endRecordIndex!)

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
        expect(deriveRuntimeFailureIntervals(artifact.trace)).toEqual([])

        const traceBeforeCompletion = artifact.trace.slice(0, -1)
        const terminalRecord = artifact.trace.at(-1)!
        const runtimeFailure: ScenarioTraceRecord = {
          ...terminalRecord,
          index: traceBeforeCompletion.length,
          origin: 'observation',
          clientId: 'client-a',
          sessionId: 'session-a',
          payload: {
            _tag: 'runtime.failure.observed',
            source: 'browser-console',
            code: 'browser-console-error',
            message: 'SQLite error: UNIQUE constraint failed: todos.id',
          },
        }
        const repeatedRuntimeFailure: ScenarioTraceRecord = {
          ...runtimeFailure,
          index: runtimeFailure.index + 1,
          localSequence: runtimeFailure.localSequence + 1,
        }
        const runFailure: ScenarioTraceRecord = {
          ...terminalRecord,
          index: repeatedRuntimeFailure.index + 1,
          payload: {
            _tag: 'run.failed',
            code: 'participant-runtime-failure',
            message: 'client-a/session-a reported a runtime failure',
            instructionId: null,
          },
        }
        const failedTrace = [...traceBeforeCompletion, runtimeFailure, repeatedRuntimeFailure, runFailure]
        const failureProjection = projectTraceAt({
          scenario: artifact.scenario,
          trace: failedTrace,
          cursorIndex: runFailure.index,
        })
        const failedClient = failureProjection.clients.find((client) => client.clientId === 'client-a')!

        expect(failedClient.health).toBe('degraded')
        expect(failedClient.sessions.find((session) => session.sessionId === 'session-a')?.health).toBe('failed')
        expect(failedClient.leader?.events).toEqual(finalProjection.clients[0]?.leader?.events)
        expect(deriveRuntimeFailureIntervals(failedTrace)).toEqual([
          expect.objectContaining({
            componentKey: 'session:client-a/session-a',
            clientId: 'client-a',
            sessionId: 'session-a',
            startRecordIndex: runtimeFailure.index,
            endRecordIndex: null,
            recordIndexes: [runtimeFailure.index, repeatedRuntimeFailure.index],
            summary: 'UNIQUE constraint failed: todos.id',
          }),
        ])

        const sessionRestart: ScenarioTraceRecord = {
          ...repeatedRuntimeFailure,
          index: repeatedRuntimeFailure.index + 1,
          origin: 'acknowledgement',
          localSequence: repeatedRuntimeFailure.localSequence + 1,
          payload: { _tag: 'lifecycle.session-restarted' },
        }
        const recoveredTrace = [...traceBeforeCompletion, runtimeFailure, repeatedRuntimeFailure, sessionRestart]
        const recoveredProjection = projectTraceAt({
          scenario: artifact.scenario,
          trace: recoveredTrace,
          cursorIndex: sessionRestart.index,
        })
        const recoveredClient = recoveredProjection.clients.find((client) => client.clientId === 'client-a')!

        expect(recoveredClient.health).toBe('healthy')
        expect(recoveredClient.sessions.find((session) => session.sessionId === 'session-a')?.health).toBe('healthy')
        expect(deriveRuntimeFailureIntervals(recoveredTrace)[0]?.endRecordIndex).toBe(sessionRestart.index)
      }).pipe(Vitest.withTestCtx(test)),
    15_000,
  )
})
