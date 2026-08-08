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
