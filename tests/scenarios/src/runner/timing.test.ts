import { scenarioApplications } from '../corpus/applications/registry.ts'
import {
  Effect,
  Vitest,
  defineScenario,
  derivePlaybackMoments,
  deriveScenarioOperationHistory,
  expect,
  runInProcessScenario,
  todoApplication,
} from '../test-support/scenario-test-kit.ts'
import { compileScenarioYamlSource } from '../yaml/compiler.ts'

Vitest.describe('Scenario elapsed-time instructions', () => {
  Vitest.live('waits explicitly and leaves fixed delays only between repeated actions', (test) =>
    Effect.gen(function* () {
      const compiled = compileScenarioYamlSource({
        fileName: 'timed-actions.scenario.yaml',
        applications: scenarioApplications,
        source: `
application: todo
clients:
  client-a:
    sessions: [main]
do:
  - wait: 20ms
  - repeat:
      times: 3
      as: item
      between: 15ms
      action:
        run: createTodo
        as: client-a/main
        with:
          id: timed-${'${item}'}
          text: Timed action ${'${item}'}
`,
      })
      const scenario = defineScenario({ ...compiled, oracles: [] })
      const artifact = yield* runInProcessScenario({
        scenario,
        application: todoApplication,
        options: { runId: 'timed-actions-test', sourceRevision: 'test' },
      })

      expect(artifact.status).toBe('passed')
      const waitRequested = artifact.trace.find((record) => record.payload._tag === 'wait.requested')
      const waitCompleted = artifact.trace.find((record) => record.payload._tag === 'wait.completed')
      expect(waitRequested?.payload).toEqual({ _tag: 'wait.requested', durationMs: 20 })
      expect(waitCompleted?.payload).toEqual(
        expect.objectContaining({
          _tag: 'wait.completed',
          requestedDurationMs: 20,
          actualDurationMs: expect.any(Number),
        }),
      )
      if (waitCompleted?.payload._tag === 'wait.completed')
        expect(waitCompleted.payload.actualDurationMs).toBeGreaterThanOrEqual(20)
      expect(deriveScenarioOperationHistory(artifact.trace)).toContainEqual(
        expect.objectContaining({ operationId: 'wait-0001', family: 'wait', status: 'succeeded' }),
      )

      const delayRequests = artifact.trace.filter((record) => record.payload._tag === 'action-sequence.delay.requested')
      const delayCompletions = artifact.trace.filter(
        (record) => record.payload._tag === 'action-sequence.delay.completed',
      )
      expect(delayRequests).toHaveLength(2)
      expect(delayCompletions).toHaveLength(2)
      expect(
        delayCompletions.every(
          (record) =>
            record.payload._tag === 'action-sequence.delay.completed' && record.payload.actualDurationMs >= 15,
        ),
      ).toBe(true)

      const requests = artifact.trace.filter((record) => record.payload._tag === 'action.requested')
      expect(requests).toHaveLength(3)
      expect(delayCompletions[0]!.index).toBeLessThan(requests[1]!.index)
      expect(delayCompletions[1]!.index).toBeLessThan(requests[2]!.index)
      expect(
        artifact.trace
          .slice(requests[2]!.index + 1)
          .some((record) => record.payload._tag.startsWith('action-sequence.delay')),
      ).toBe(false)
      expect(
        derivePlaybackMoments({ scenario, trace: artifact.trace }).filter((moment) => moment.kind === 'wait'),
      ).toHaveLength(3)
    }).pipe(Vitest.withTestCtx(test)),
  )
})
