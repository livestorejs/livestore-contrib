import {
  Deferred,
  Effect,
  Vitest,
  defineScenario,
  deriveOverlappingScenarioOperationPairs,
  deriveScenarioOperationHistory,
  deriveScenarioOperationHistoryProjection,
  expect,
  makeInProcessHost,
  makeMockScenarioBackend,
  participantHostFailure,
  runScenario,
  todoApplication,
} from './test-support/scenario-test-kit.ts'

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
