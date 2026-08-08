import {
  Effect,
  Exit,
  ScenarioRunArtifact,
  Schema,
  Vitest,
  defineScenario,
  deriveInFlightScenarioOperationIds,
  derivePlaybackMoments,
  deriveScenarioOperationHistory,
  expect,
  makeInProcessHost,
  makeMockScenarioBackend,
  offlineWriterRecovery,
  participantHostFailure,
  projectTraceAt,
  runScenario,
  todoApplication,
} from '../../test-support/scenario-test-kit.ts'

Vitest.describe('in-process host conformance', () => {
  Vitest.live('rejects inferred incompatible behavior before creating any Client', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      let createClientCalls = 0
      const incompatibleScenario = defineScenario({
        version: 3,
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
        instructions: [
          {
            _tag: 'annotation',
            id: 'lifecycle',
            text: 'Restart the Client.',
          },
          { _tag: 'restart-client', id: 'restart-client-a', clientId: 'client-a' },
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
          instructions: [],
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
      const timeoutMs = 250
      const scenario = defineScenario({
        version: 3,
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
        instructions: [
          {
            _tag: 'annotation',
            id: 'failure',
            text: 'Fault removal is acknowledged but the participant does not recover before the deadline.',
          },
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
            timeoutMs,
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
          timeoutMs,
          observations: [
            expect.objectContaining({ participant: 'client-a/session-a', pendingCount: 1, isSynced: false }),
          ],
        }),
      )
      expect(artifact.trace.at(-1)?.payload).toEqual(
        expect.objectContaining({
          _tag: 'run.failed',
          code: 'settlement-timeout',
          instructionId: 'must-time-out',
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
        version: 3,
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
        instructions: [
          {
            _tag: 'annotation',
            id: 'operation',
            text: 'Lose the host completion response.',
          },
          {
            _tag: 'action',
            id: 'ambiguous-action',
            target: { clientId: 'client-a', sessionId: 'session-a' },
            action: 'createTodo',
            input: { id: 'ambiguous', text: 'possibly committed' },
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
        expect.objectContaining({ _tag: 'run.failed', instructionId: 'settle-after-reconnect' }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )
})

/**
 * Verifies the first vertical slice of LS.SYS.VER.SCEN-R02, R04, R07, R11 to
 * R16, and R18.
 */
