Vitest.describe('seeded workloads', () => {
  Vitest.live(
    'repeats the same generated actions for the same seed and retains every action as trace evidence',
    (test) =>
      Effect.gen(function* () {
        const first = yield* runInProcessScenario({
          scenario: seededTodoWorkload,
          application: todoApplication,
          options: { runId: 'seeded-workload-first', sourceRevision: 'test' },
        })
        const second = yield* runInProcessScenario({
          scenario: seededTodoWorkload,
          application: todoApplication,
          options: { runId: 'seeded-workload-second', sourceRevision: 'test' },
        })
        const differentSeed = yield* runInProcessScenario({
          scenario: defineScenario({
            ...seededTodoWorkload,
            id: 'seeded-todo-workload-different-seed',
            seed: seededTodoWorkload.seed + 1,
          }),
          application: todoApplication,
          options: { runId: 'seeded-workload-different-seed', sourceRevision: 'test' },
        })

        expect(first.status).toBe('passed')
        expect(second.status).toBe('passed')
        expect(differentSeed.status).toBe('passed')
        expect(workloadActionSignature(first)).toEqual(workloadActionSignature(second))
        expect(workloadActionSignature(first)).not.toEqual(workloadActionSignature(differentSeed))

        const requested = first.trace.find((record) => record.payload._tag === 'workload.requested')
        const completed = first.trace.find((record) => record.payload._tag === 'workload.completed')
        expect(requested?.payload).toEqual(
          expect.objectContaining({ _tag: 'workload.requested', workload: 'createTodoBurst', count: 12 }),
        )
        expect(completed?.payload).toEqual(
          expect.objectContaining({
            _tag: 'workload.completed',
            actionIds: Array.from(
              { length: 12 },
              (_, index) => `create-seeded-todos:${String(index + 1).padStart(4, '0')}`,
            ),
          }),
        )
        expect(
          first.trace.filter(
            (record) => record.payload._tag === 'action.requested' && record.causationId === 'create-seeded-todos',
          ),
        ).toHaveLength(12)
        expect(
          deriveScenarioOperationHistory(first.trace).find(
            (operation) => operation.operationId === 'create-seeded-todos',
          ),
        ).toEqual(expect.objectContaining({ family: 'workload', status: 'succeeded' }))
      }).pipe(Vitest.withTestCtx(test)),
    20_000,
  )
})
import {
  Effect,
  Vitest,
  defineScenario,
  deriveScenarioOperationHistory,
  expect,
  runInProcessScenario,
  seededTodoWorkload,
  todoApplication,
} from './test-support/scenario-test-kit.ts'
import { workloadActionSignature } from './test-support/runner-assertions.ts'

