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

  Vitest.live('resolves workload libraries before creating any Client', (test) =>
    Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      let createClientCalls = 0
      const countingHost = {
        ...host,
        createClient: (command: Parameters<typeof host.createClient>[0]) => {
          createClientCalls += 1
          return host.createClient(command)
        },
      }
      const error = yield* runScenario({
        scenario: seededTodoWorkload,
        applicationId: todoApplication.id,
        host: countingHost,
        workloads: {},
        options: { runId: 'missing-workload-library-test', sourceRevision: 'test' },
      }).pipe(Effect.flip)

      expect(createClientCalls).toBe(0)
      expect(error).toEqual(
        expect.objectContaining({
          code: 'unknown-workload',
          message: expect.stringContaining('createTodoBurst'),
        }),
      )

      const invalidInputScenario = defineScenario({
        ...seededTodoWorkload,
        id: 'invalid-workload-input',
        phases: seededTodoWorkload.phases.map((phase) => ({
          ...phase,
          steps: phase.steps.map((step) =>
            step._tag === 'workload' ? { ...step, input: { idPrefix: 'missing-text-prefix' } } : step,
          ),
        })),
      })
      const invalidInputError = yield* runScenario({
        scenario: invalidInputScenario,
        applicationId: todoApplication.id,
        host: countingHost,
        workloads: todoApplication.workloads,
        options: { runId: 'invalid-workload-input-test', sourceRevision: 'test' },
      }).pipe(Effect.flip)
      expect(createClientCalls).toBe(0)
      expect(invalidInputError).toEqual(expect.objectContaining({ code: 'invalid-workload-input' }))
    }).pipe(Vitest.withTestCtx(test)),
  )
})
import {
  Effect,
  Vitest,
  defineScenario,
  expect,
  makeInProcessHost,
  makeMockScenarioBackend,
  offlineWriterRecovery,
  runScenario,
  seededTodoWorkload,
  todoApplication,
} from './test-support/scenario-test-kit.ts'

