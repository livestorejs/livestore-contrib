import {
  Effect,
  Vitest,
  expect,
  makeInProcessHost,
  makeMockScenarioBackend,
  offlineWriterRecovery,
  runScenario,
  todoApplication,
} from '../test-support/scenario-test-kit.ts'

Vitest.describe('scenario runner preflight', () => {
  Vitest.live('rejects a typed AST that bypasses participant-reference construction validation', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      let createClientCalls = 0
      const bypassedScenario = {
        ...offlineWriterRecovery,
        id: 'preflight-unknown-participant',
        oracles: offlineWriterRecovery.oracles.map((oracle) => ({
          ...oracle,
          participants: [{ clientId: 'unknown-client', sessionId: 'unknown-session' }],
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
        options: { runId: 'preflight-unknown-participant-test', sourceRevision: 'test' },
      }).pipe(Effect.flip)

      expect(createClientCalls).toBe(0)
      expect(error).toEqual(
        expect.objectContaining({
          code: 'invalid-scenario',
          message: expect.stringContaining('Unknown participant reference: unknown-client/unknown-session'),
        }),
      )
    }).pipe(Vitest.withTestCtx(test)),
  )
})
