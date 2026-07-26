import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

import { expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Deferred, Effect, Exit, Schema } from '@livestore/utils/effect'

import {
  participantHostFailure,
  type ParticipantHostFailureCode,
  type ScenarioOperationFailureOutcome,
} from './application.ts'
import { makeMockScenarioBackend } from './backends.ts'
import { browserHostCapabilities } from './browser/browser-host.ts'
import { deriveScenarioRequirements } from './capabilities.ts'
import { backendOutageRecovery } from './corpus/backend-outage-recovery.ts'
import { browserMultiSessionRecovery } from './corpus/browser-multi-session-recovery.ts'
import { offlineWriterRecovery } from './corpus/offline-writer-recovery.ts'
import { sharedTodoWorkday } from './corpus/shared-todo-workday.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { inProcessHostCapabilities, makeInProcessHost } from './host.ts'
import { defineScenario, ScenarioRunArtifact, type ScenarioTraceRecord } from './model.ts'
import { processHostCapabilities } from './process/process-host.ts'
import {
  deriveAdaptiveTimeLayout,
  deriveConnectivityIntervals,
  deriveEventTimeline,
  deriveExplicitCausalEdges,
  deriveInFlightScenarioOperationIds,
  deriveLaneActivityIntervals,
  deriveOverlappingScenarioOperationPairs,
  derivePlaybackMoments,
  deriveRuntimeFailureIntervals,
  deriveScenarioOperationHistory,
  deriveScenarioOperationHistoryProjection,
  deriveTraceCaptures,
  projectAdaptiveTime,
  projectTraceAt,
} from './projection.ts'
import {
  runBrowserLocalSyncCfScenario,
  runInProcessLocalSyncCfScenario,
  runInProcessScenario,
  runProcessLocalSyncCfScenario,
  runScenario,
} from './runner.ts'

/** Verifies: LS.SYS.VER.SCEN-R01, LS.SYS.VER.SCEN-R03, LS.SYS.VER.SCEN-R06 */
Vitest.describe('scenario model', () => {
  Vitest.it('validates and round-trips the versioned serializable AST', () => {
    const encoded = JSON.parse(JSON.stringify(offlineWriterRecovery))
    expect(defineScenario(encoded)).toEqual(offlineWriterRecovery)
  })

  Vitest.it('derives host requirements from topology, operations, observations, and oracles', () => {
    expect(
      deriveScenarioRequirements(
        defineScenario({
          ...browserMultiSessionRecovery,
          requires: [],
        }),
      ),
    ).toEqual([
      'system-observation',
      'sync-observation',
      'multiple-sessions',
      'named-actions',
      'session-restart',
      'client-restart',
      'state-inspection',
    ])
  })

  Vitest.it('requires a terminal Settlement for snapshot-based oracles', () => {
    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'missing-terminal-settlement',
        phases: offlineWriterRecovery.phases.map((phase) => ({
          ...phase,
          steps: phase.steps.filter((step) => step._tag !== 'settle'),
        })),
      }),
    ).toThrow('Snapshot-based oracles require a terminal Settlement')
  })

  Vitest.it('rejects a modifying operation after the Settlement used by snapshot-based oracles', () => {
    const lastPhaseIndex = offlineWriterRecovery.phases.length - 1

    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'stale-terminal-settlement',
        phases: offlineWriterRecovery.phases.map((phase, index) =>
          index === lastPhaseIndex
            ? {
                ...phase,
                steps: [
                  ...phase.steps,
                  {
                    _tag: 'action' as const,
                    id: 'write-after-settlement',
                    target: { clientId: 'client-a', sessionId: 'session-a' },
                    action: 'createTodo',
                    input: { id: 'too-late', text: 'This invalidates the Settlement evidence' },
                  },
                ],
              }
            : phase,
        ),
      }),
    ).toThrow('Snapshot-based oracles require a terminal Settlement')
  })

  Vitest.it('requires the terminal Settlement to cover every snapshot-oracle participant', () => {
    const lastPhaseIndex = offlineWriterRecovery.phases.length - 1

    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'incomplete-terminal-settlement',
        phases: offlineWriterRecovery.phases.map((phase, index) =>
          index === lastPhaseIndex
            ? {
                ...phase,
                steps: phase.steps.map((step) =>
                  step._tag === 'settle'
                    ? { ...step, participants: [{ clientId: 'client-a', sessionId: 'session-a' }] }
                    : step,
                ),
              }
            : phase,
        ),
      }),
    ).toThrow('Terminal Settlement is missing snapshot-oracle participants: client-b/session-b')
  })

  Vitest.it('allows operation-history-only scenarios without Settlement', () => {
    const scenario = defineScenario({
      ...offlineWriterRecovery,
      id: 'history-without-settlement',
      phases: offlineWriterRecovery.phases.map((phase) => ({
        ...phase,
        steps: phase.steps.filter((step) => step._tag !== 'settle'),
      })),
      oracles: offlineWriterRecovery.oracles.filter((oracle) => oracle._tag === 'operation-history'),
    })

    expect(scenario.phases.flatMap((phase) => phase.steps).every((step) => step._tag !== 'settle')).toBe(true)
  })

  Vitest.it('expands the shared workday into exactly 100 mixed application actions', () => {
    const steps = sharedTodoWorkday.phases.flatMap((phase) => phase.steps)
    const actionSteps = steps.filter((step) => step._tag === 'action')

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

    const disconnectIndex = steps.findIndex((step) => step._tag === 'disconnect' && step.clientId === 'alice-phone')
    const reconnectIndex = steps.findIndex((step) => step._tag === 'reconnect' && step.clientId === 'alice-phone')
    const actionsBeforeDisconnect = steps.slice(0, disconnectIndex).filter((step) => step._tag === 'action')
    const actionsWhileDisconnected = steps
      .slice(disconnectIndex + 1, reconnectIndex)
      .filter((step) => step._tag === 'action')
    const actionsAfterReconnect = steps.slice(reconnectIndex + 1).filter((step) => step._tag === 'action')
    const offlinePhoneActions = actionsWhileDisconnected.filter((step) => step.target.clientId === 'alice-phone')

    expect([actionsBeforeDisconnect.length, actionsWhileDisconnected.length, actionsAfterReconnect.length]).toEqual([
      33, 34, 33,
    ])
    expect(offlinePhoneActions).toHaveLength(6)
    expect(new Set(offlinePhoneActions.map((step) => step.action))).toEqual(
      new Set(['createTodo', 'editTodo', 'setTodoCompleted', 'deleteTodo']),
    )
    expect(
      steps
        .slice(disconnectIndex + 1, reconnectIndex)
        .filter((step) => step._tag === 'settle')
        .every((step) => step.participants.every((participant) => participant.clientId !== 'alice-phone')),
    ).toBe(true)
  })

  Vitest.it('decodes the tracked version-3/version-4 reference artifacts without migration', () => {
    for (const name of [
      'reference-offline-writer-recovery-browser-failure.json.gz',
      'reference-shared-todo-workday-browser-failure.json.gz',
    ]) {
      const json = gunzipSync(readFileSync(new URL(`../artifacts/${name}`, import.meta.url))).toString('utf8')
      const artifact = Schema.decodeUnknownSync(Schema.fromJsonString(ScenarioRunArtifact))(json)
      expect(artifact.artifactVersion).toBe(4)
      expect(artifact.descriptor.traceVersion).toBe(3)
    }
  })
})

Vitest.describe('scenario runner preflight', () => {
  Vitest.live('rejects a typed AST that bypasses terminal Settlement construction validation', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      let createClientCalls = 0
      const bypassedScenario = {
        ...offlineWriterRecovery,
        id: 'preflight-missing-terminal-settlement',
        phases: offlineWriterRecovery.phases.map((phase) => ({
          ...phase,
          steps: phase.steps.filter((step) => step._tag !== 'settle'),
        })),
      }
      const error = yield* runScenario({
        scenario: bypassedScenario,
        applicationId: todoApplication.id,
        host: {
          ...host,
          createClient: (command) => {
            createClientCalls += 1
            return host.createClient(command)
          },
        },
        options: { runId: 'preflight-missing-terminal-settlement-test', sourceRevision: 'test' },
      }).pipe(Effect.flip)

      expect(createClientCalls).toBe(0)
      expect(error).toEqual(
        expect.objectContaining({
          code: 'invalid-scenario',
          message: expect.stringContaining('Snapshot-based oracles require a terminal Settlement'),
        }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )
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

Vitest.describe('participant-host failure conformance', () => {
  Vitest.it('does not advertise exact Event lineage for sampled-correlation hosts', () => {
    for (const capabilities of [inProcessHostCapabilities, processHostCapabilities, browserHostCapabilities]) {
      expect(capabilities.capabilities).not.toContain('event-lineage')
    }
  })

  Vitest.it('keeps portable failure category independent from operation certainty', () => {
    const cases: ReadonlyArray<{
      code: ParticipantHostFailureCode
      operationOutcome: ScenarioOperationFailureOutcome
    }> = [
      { code: 'host-infrastructure-failure', operationOutcome: 'definite-failure' },
      { code: 'host-request-rejected', operationOutcome: 'definite-failure' },
      { code: 'host-response-invalid', operationOutcome: 'definite-failure' },
      { code: 'host-response-timeout', operationOutcome: 'indefinite' },
      { code: 'host-transport-failure', operationOutcome: 'definite-failure' },
      { code: 'host-transport-failure', operationOutcome: 'indefinite' },
    ]

    expect(
      cases.map(({ code, operationOutcome }) => {
        const error = participantHostFailure({ code, message: 'profile-specific detail', operationOutcome })
        return { code: error.code, operationOutcome: error.operationOutcome }
      }),
    ).toEqual(cases)
  })
})

Vitest.describe('scenario operation history', () => {
  Vitest.live(
    'retains overlapping operation intervals and evaluates a history property',
    (test) =>
      Effect.gen(function* () {
        const clientA = { clientId: 'client-a', sessionId: 'session-a' } as const
        const clientB = { clientId: 'client-b', sessionId: 'session-b' } as const
        const scenario = defineScenario({
          version: 1,
          id: 'parallel-operation-history',
          description: 'Exercises overlapping application operations and history checking.',
          tags: ['operation-history', 'parallel'],
          seed: 22,
          applicationId: todoApplication.id,
          requires: ['multiple-clients', 'named-actions', 'sync-observation'],
          topology: {
            storeId: 'parallel-operation-history',
            clients: [
              { id: clientA.clientId, sessions: [clientA.sessionId], initiallyConnected: true },
              { id: clientB.clientId, sessions: [clientB.sessionId], initiallyConnected: true },
            ],
          },
          phases: [
            {
              id: 'overlap',
              description: 'Release both writes only after both host requests have started.',
              steps: [
                {
                  _tag: 'parallel',
                  id: 'parallel-writes',
                  operations: [
                    {
                      _tag: 'action',
                      id: 'write-a',
                      target: clientA,
                      action: 'createTodo',
                      input: { id: 'parallel-a', text: 'Written by Client A' },
                    },
                    {
                      _tag: 'action',
                      id: 'write-b',
                      target: clientB,
                      action: 'createTodo',
                      input: { id: 'parallel-b', text: 'Written by Client B' },
                    },
                  ],
                },
                {
                  _tag: 'settle',
                  id: 'settle-parallel-writes',
                  participants: [clientA, clientB],
                  healDisconnectedClients: [],
                  timeoutMs: 3_000,
                },
              ],
            },
          ],
          oracles: [
            {
              _tag: 'operation-history',
              id: 'writes-overlapped',
              operationIds: ['write-a', 'write-b'],
              requireOverlap: true,
              allowIndefinite: false,
            },
          ],
        })
        const backend = yield* makeMockScenarioBackend
        const host = yield* makeInProcessHost({ application: todoApplication, backend })
        const bothStarted = yield* Deferred.make<void>()
        let started = 0
        const artifact = yield* runScenario({
          scenario,
          applicationId: todoApplication.id,
          host: {
            ...host,
            dispatchAction: (command) =>
              Effect.gen(function* () {
                started += 1
                if (started === 2) yield* Deferred.succeed(bothStarted, undefined)
                yield* Deferred.await(bothStarted)
                return yield* host.dispatchAction(command)
              }),
          },
          options: { runId: 'parallel-operation-history-test', sourceRevision: 'test' },
        })

        const history = deriveScenarioOperationHistoryProjection(artifact.trace)
        const writes = history.operations.filter((operation) => operation.operationId.startsWith('write-'))
        expect(artifact.status).toBe('passed')
        expect(history.coverage.excludedInteractions).toContain('state-inspection')
        expect(writes).toEqual([
          expect.objectContaining({ operationId: 'write-a', family: 'application-action', status: 'succeeded' }),
          expect.objectContaining({ operationId: 'write-b', family: 'application-action', status: 'succeeded' }),
        ])
        expect(deriveOverlappingScenarioOperationPairs(writes)).toEqual([
          { leftOperationId: 'write-a', rightOperationId: 'write-b' },
        ])
        expect(artifact.verdicts).toContainEqual(
          expect.objectContaining({ oracleId: 'writes-overlapped', status: 'passed' }),
        )
      }).pipe(Vitest.withTestCtx(test)),
    15_000,
  )

  Vitest.live('awaits every parallel child and retains sibling outcomes when one fails', (test) =>
    Effect.gen(function* () {
      const clientA = { clientId: 'client-a', sessionId: 'session-a' } as const
      const clientB = { clientId: 'client-b', sessionId: 'session-b' } as const
      const scenario = defineScenario({
        version: 1,
        id: 'parallel-operation-failure',
        description: 'Retains all child outcomes when a parallel operation fails.',
        tags: ['operation-history', 'parallel', 'failure'],
        seed: 23,
        applicationId: todoApplication.id,
        requires: ['multiple-clients', 'named-actions', 'sync-observation'],
        topology: {
          storeId: 'parallel-operation-failure',
          clients: [
            { id: clientA.clientId, sessions: [clientA.sessionId], initiallyConnected: true },
            { id: clientB.clientId, sessions: [clientB.sessionId], initiallyConnected: true },
          ],
        },
        phases: [
          {
            id: 'failure',
            description: 'One child succeeds while its sibling is rejected.',
            steps: [
              {
                _tag: 'parallel',
                id: 'parallel-writes',
                operations: [
                  {
                    _tag: 'action',
                    id: 'write-succeeds',
                    target: clientA,
                    action: 'createTodo',
                    input: { id: 'parallel-success', text: 'Retained success' },
                  },
                  {
                    _tag: 'action',
                    id: 'write-fails',
                    target: clientB,
                    action: 'createTodo',
                    input: { id: 'parallel-failure', text: 'Rejected write' },
                  },
                ],
              },
            ],
          },
        ],
        oracles: [],
      })
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      const artifact = yield* runScenario({
        scenario,
        applicationId: todoApplication.id,
        host: {
          ...host,
          dispatchAction: (command) =>
            command.operationId === 'write-fails'
              ? Effect.fail(
                  participantHostFailure({
                    code: 'host-request-rejected',
                    message: 'Synthetic definite rejection',
                    operationOutcome: 'definite-failure',
                  }),
                )
              : host.dispatchAction(command),
        },
        options: { runId: 'parallel-operation-failure-test', sourceRevision: 'test' },
      })

      const history = deriveScenarioOperationHistory(artifact.trace).filter((operation) =>
        operation.operationId.startsWith('write-'),
      )
      expect(artifact.status).toBe('failed')
      expect(history).toEqual([
        expect.objectContaining({ operationId: 'write-succeeds', status: 'succeeded' }),
        expect.objectContaining({ operationId: 'write-fails', status: 'definite-failure' }),
      ])
      expect(artifact.trace.at(-1)?.payload).toEqual(
        expect.objectContaining({ _tag: 'run.failed', stepId: 'write-fails' }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )
})

/** Verifies: LS.SYS.VER.SCEN-R05, LS.SYS.VER.SCEN-R06, LS.SYS.VER.SCEN-R08 */
Vitest.describe('in-process host conformance', () => {
  Vitest.live('rejects inferred incompatible behavior before creating any Client', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      let createClientCalls = 0
      const incompatibleScenario = defineScenario({
        version: 1,
        id: 'preflight-incompatible-lifecycle',
        description: 'Requires a Client restart without declaring it manually.',
        tags: ['preflight'],
        seed: 1,
        applicationId: todoApplication.id,
        requires: [],
        topology: {
          storeId: 'preflight-incompatible-lifecycle',
          clients: [{ id: 'client-a', sessions: ['session-a1'], initiallyConnected: true }],
        },
        phases: [
          {
            id: 'lifecycle',
            description: 'Restart the Client.',
            steps: [{ _tag: 'restart-client', id: 'restart-client-a', clientId: 'client-a' }],
          },
        ],
        oracles: [],
      })

      const exit = yield* runScenario({
        scenario: incompatibleScenario,
        applicationId: todoApplication.id,
        host: {
          ...host,
          createClient: (command) =>
            Effect.sync(() => {
              createClientCalls += 1
              return command
            }).pipe(Effect.flatMap(host.createClient)),
        },
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(createClientCalls).toBe(0)

      const oversizedExit = yield* runScenario({
        scenario: defineScenario({
          ...incompatibleScenario,
          id: 'preflight-oversized-client',
          topology: {
            storeId: 'preflight-oversized-client',
            clients: [{ id: 'client-a', sessions: ['session-a1', 'session-a2'], initiallyConnected: true }],
          },
          phases: [],
        }),
        applicationId: todoApplication.id,
        host: {
          ...host,
          createClient: (command) =>
            Effect.sync(() => {
              createClientCalls += 1
              return command
            }).pipe(Effect.flatMap(host.createClient)),
        },
      }).pipe(Effect.exit)

      expect(Exit.isFailure(oversizedExit)).toBe(true)
      expect(createClientCalls).toBe(0)
    }).pipe(Vitest.withTestCtx(test)),
  )

  Vitest.live('captures a non-convergent settlement as an inspectable failed artifact', (test) =>
    Effect.gen(function* () {
      const participant = { clientId: 'client-a', sessionId: 'session-a' } as const
      const scenario = defineScenario({
        version: 1,
        id: 'captured-settlement-failure',
        description: 'Exercises the failed-settlement artifact contract.',
        tags: ['failure-capture'],
        seed: 1442,
        applicationId: todoApplication.id,
        requires: ['multiple-clients', 'sync-observation'],
        topology: {
          storeId: 'captured-settlement-failure',
          clients: [{ id: participant.clientId, sessions: [participant.sessionId], initiallyConnected: true }],
        },
        phases: [
          {
            id: 'failure',
            description: 'Fault removal is acknowledged but the participant does not recover before the deadline.',
            steps: [
              { _tag: 'disconnect', id: 'disconnect-client-a', clientId: participant.clientId },
              {
                _tag: 'action',
                id: 'offline-write-that-cannot-recover',
                target: participant,
                action: 'createTodo',
                input: { id: 'stuck-offline', text: 'Recovery remains pending' },
              },
              {
                _tag: 'settle',
                id: 'must-time-out',
                participants: [participant],
                healDisconnectedClients: [participant.clientId],
                timeoutMs: 10,
              },
            ],
          },
        ],
        oracles: [],
      })

      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      let removalAcknowledged = false
      const artifact = yield* runScenario({
        scenario,
        applicationId: todoApplication.id,
        host: {
          ...host,
          setConnectivity: (command) =>
            command.connected === true
              ? Effect.sync(() => {
                  removalAcknowledged = true
                  return { operationId: command.operationId, status: 'acknowledged' as const }
                })
              : host.setConnectivity(command),
          observeSystem: host.observeSystem.pipe(
            Effect.map((observation) =>
              removalAcknowledged === false
                ? observation
                : {
                    ...observation,
                    clients: observation.clients.map((client) =>
                      client.clientId === participant.clientId ? { ...client, connected: true } : client,
                    ),
                  },
            ),
          ),
        },
        options: { runId: 'captured-settlement-failure-test', sourceRevision: 'test' },
      })

      expect(artifact.status).toBe('failed')
      expect(artifact.snapshots).toEqual([])
      const settlementFailure = artifact.trace.find((record) => record.payload._tag === 'settlement.failed')
      expect(settlementFailure?.payload).toEqual(
        expect.objectContaining({
          _tag: 'settlement.failed',
          code: 'settlement-timeout',
          timeoutMs: 10,
          observations: [
            expect.objectContaining({ participant: 'client-a/session-a', pendingCount: 1, isSynced: false }),
          ],
        }),
      )
      expect(artifact.trace.at(-1)?.payload).toEqual(
        expect.objectContaining({
          _tag: 'run.failed',
          code: 'settlement-timeout',
          phaseId: 'failure',
          stepId: 'must-time-out',
        }),
      )
      const operationHistory = deriveScenarioOperationHistory(artifact.trace)
      expect(operationHistory.find((operation) => operation.operationId === 'must-time-out')).toEqual(
        expect.objectContaining({ status: 'definite-failure', outcomeRecordIndex: expect.any(Number) }),
      )
      expect(artifact.trace.find((record) => record.payload._tag === 'operation.outcome')?.causedBy).toHaveLength(1)
      expect(artifact.trace.find((record) => record.payload._tag === 'fault.removed')).toBeDefined()
      const recoveryObservations = artifact.trace.filter((record) => record.payload._tag === 'recovery.observed')
      expect(recoveryObservations.length).toBeGreaterThan(0)
      expect(
        recoveryObservations.every(
          (record) => record.payload._tag === 'recovery.observed' && record.payload.converged === false,
        ),
      ).toBe(true)
      expect(artifact.trace.some((record) => record.payload._tag === 'recovery.completed')).toBe(false)
      expect(
        projectTraceAt({ scenario, trace: artifact.trace, cursorIndex: artifact.trace.length - 1 }).runStatus,
      ).toBe('failed')
      expect(derivePlaybackMoments({ scenario, trace: artifact.trace }).at(-1)?.kind).toBe('failure')
      expect(() => Schema.decodeUnknownSync(ScenarioRunArtifact)(artifact)).not.toThrow()
    }).pipe(Vitest.withTestCtx(test)),
  )

  Vitest.live('retains an indefinite operation outcome when the host loses completion evidence', (test) =>
    Effect.gen(function* () {
      const scenario = defineScenario({
        version: 1,
        id: 'indefinite-operation-outcome',
        description: 'Exercises ambiguous participant-host completion.',
        tags: ['failure-capture'],
        seed: 7,
        applicationId: todoApplication.id,
        requires: [],
        topology: {
          storeId: 'indefinite-operation-outcome',
          clients: [{ id: 'client-a', sessions: ['session-a'], initiallyConnected: true }],
        },
        phases: [
          {
            id: 'operation',
            description: 'Lose the host completion response.',
            steps: [
              {
                _tag: 'action',
                id: 'ambiguous-action',
                target: { clientId: 'client-a', sessionId: 'session-a' },
                action: 'createTodo',
                input: { id: 'ambiguous', text: 'possibly committed' },
              },
            ],
          },
        ],
        oracles: [],
      })
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      const artifact = yield* runScenario({
        scenario,
        applicationId: todoApplication.id,
        host: {
          ...host,
          dispatchAction: () =>
            Effect.fail(
              participantHostFailure({
                code: 'host-response-timeout',
                message: 'The request may have completed before its response was lost',
                operationOutcome: 'indefinite',
              }),
            ),
        },
        options: { runId: 'indefinite-operation-outcome-test', sourceRevision: 'test' },
      })

      expect(
        deriveScenarioOperationHistory(artifact.trace).find(
          (operation) => operation.operationId === 'ambiguous-action',
        ),
      ).toEqual(expect.objectContaining({ status: 'indefinite', outcomeRecordIndex: expect.any(Number) }))
      const invocation = artifact.trace.find(
        (record) => record.payload._tag === 'action.requested' && record.correlationId === 'ambiguous-action',
      )
      expect(deriveInFlightScenarioOperationIds(artifact.trace.slice(0, (invocation?.index ?? -1) + 1))).toEqual([
        'ambiguous-action',
      ])
      expect(deriveInFlightScenarioOperationIds(artifact.trace)).toEqual([])
      expect(artifact.trace.find((record) => record.payload._tag === 'operation.outcome')?.payload).toEqual(
        expect.objectContaining({ status: 'indefinite', code: 'host-response-timeout' }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )

  Vitest.live('retains nested settlement-control failure outcomes', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      const artifact = yield* runScenario({
        scenario: offlineWriterRecovery,
        applicationId: todoApplication.id,
        host: {
          ...host,
          setConnectivity: (command) =>
            command.operationId === 'settle-after-reconnect:heal:client-a'
              ? Effect.fail(
                  participantHostFailure({
                    code: 'host-transport-failure',
                    message: 'Reconnect completion was not observed',
                    operationOutcome: 'indefinite',
                  }),
                )
              : host.setConnectivity(command),
        },
        options: { runId: 'nested-settlement-failure-test', sourceRevision: 'test' },
      })

      const history = deriveScenarioOperationHistory(artifact.trace)
      expect(artifact.status).toBe('failed')
      expect(history.find((operation) => operation.operationId === 'settle-after-reconnect:heal:client-a')).toEqual(
        expect.objectContaining({ status: 'indefinite' }),
      )
      expect(history.find((operation) => operation.operationId === 'settle-after-reconnect')).toEqual(
        expect.objectContaining({ status: 'indefinite' }),
      )
      expect(deriveInFlightScenarioOperationIds(artifact.trace)).toEqual([])
      expect(artifact.trace.at(-1)?.payload).toEqual(
        expect.objectContaining({ _tag: 'run.failed', stepId: 'settle-after-reconnect' }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )
})

/**
 * Verifies the first vertical slice of LS.SYS.VER.SCEN-R02, R04, R07, R11 to
 * R16, and R18.
 */
Vitest.describe('offline writer recovery', () => {
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
        expect(artifact.artifactVersion).toBe(4)
        expect(artifact.descriptor.traceVersion).toBe(3)
        expect(artifact.verdicts).toHaveLength(5)
        expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
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
            phaseId: terminalRecord.phaseId,
            stepId: null,
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

/** Verifies the local-concrete backend realization independently of participant placement. */
Vitest.describe('local sync-cf backend', () => {
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

/** Verifies the persisted web topology, browser network boundary, and lifecycle controls. */
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

/** Ensures sampled correlation remains useful for one unambiguous pending-to-confirmed Event. */
const expectOfflineEventCorrelationLifecycle = (artifact: ScenarioRunArtifact): void => {
  const reconnectIndex = artifact.trace.find(
    (record) => record.clientId === 'client-a' && record.payload._tag === 'connectivity.reconnected',
  )?.index
  expect(reconnectIndex).toBeDefined()
  const offlineObservation = artifact.trace.find(
    (record) =>
      reconnectIndex !== undefined &&
      record.index < reconnectIndex &&
      record.clientId === 'client-a' &&
      record.payload._tag === 'leader.sync.observed' &&
      record.payload.observation.events.some(
        (event) => event.origin.clientId === 'client-a' && event.disposition === 'pending',
      ),
  )
  expect(offlineObservation?.payload._tag).toBe('leader.sync.observed')
  if (offlineObservation?.payload._tag !== 'leader.sync.observed') return

  const pendingEvent = offlineObservation.payload.observation.events.find(
    (event) => event.origin.clientId === 'client-a' && event.disposition === 'pending',
  )
  expect(pendingEvent).toBeDefined()
  expect(offlineObservation.payload.observation.pendingCount).toBeGreaterThan(0)

  const recoveredObservation = artifact.trace.findLast(
    (record) =>
      record.clientId === 'client-a' &&
      record.payload._tag === 'leader.sync.observed' &&
      record.payload.reason === 'settle-after-reconnect',
  )
  expect(recoveredObservation?.payload._tag).toBe('leader.sync.observed')
  if (pendingEvent === undefined || recoveredObservation?.payload._tag !== 'leader.sync.observed') return

  expect(recoveredObservation.payload.observation.pendingCount).toBe(0)
  expect(recoveredObservation.payload.observation.events).toContainEqual(
    expect.objectContaining({ eventRef: pendingEvent.eventRef, disposition: 'confirmed' }),
  )
}

const expectBackendOutageRecovery = (artifact: ScenarioRunArtifact): void => {
  expect(artifact.status).toBe('passed')
  const injected = artifact.trace.find(
    (record) => record.payload._tag === 'fault.injected' && record.payload.fault === 'backend-unavailable',
  )
  const removed = artifact.trace.find(
    (record) => record.payload._tag === 'fault.removed' && record.payload.fault === 'backend-unavailable',
  )
  const recovered = artifact.trace.find(
    (record) =>
      record.payload._tag === 'recovery.completed' && record.payload.faultIds.includes('backend-outage-started'),
  )
  expect(injected).toBeDefined()
  expect(removed?.index).toBeGreaterThan(injected?.index ?? Number.POSITIVE_INFINITY)
  expect(recovered?.index).toBeGreaterThan(removed?.index ?? Number.POSITIVE_INFINITY)
  const observedOutage = artifact.trace.find(
    (record) =>
      record.index > (injected?.index ?? Number.POSITIVE_INFINITY) &&
      record.index < (removed?.index ?? Number.NEGATIVE_INFINITY) &&
      record.payload._tag === 'backend.observed' &&
      record.payload.observation.connected === false,
  )
  const pendingDuringOutage = artifact.trace.find(
    (record) =>
      record.index > (injected?.index ?? Number.POSITIVE_INFINITY) &&
      record.index < (removed?.index ?? Number.NEGATIVE_INFINITY) &&
      record.payload._tag === 'leader.sync.observed' &&
      record.payload.observation.pendingCount > 0,
  )
  expect(observedOutage).toBeDefined()
  expect(pendingDuringOutage).toBeDefined()
  expect(artifact.snapshots.every((snapshot) => snapshot.sync.pendingCount === 0)).toBe(true)
  expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
}
