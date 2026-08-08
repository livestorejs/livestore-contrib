import { generatedActionSignature } from '../test-support/runner-assertions.ts'
import {
  Effect,
  Vitest,
  deriveScenarioOperationHistory,
  derivePlaybackMoments,
  expect,
  runInProcessScenario,
  makeSeededTodoActions,
  seededTodoActions,
  todoApplication,
} from '../test-support/scenario-test-kit.ts'

Vitest.describe('Scenario-owned generated actions', () => {
  Vitest.live(
    'repeats the same generated actions for the same seed and retains every action as trace evidence',
    (test) =>
      Effect.gen(function* () {
        const first = yield* runInProcessScenario({
          scenario: seededTodoActions,
          application: todoApplication,
          options: { runId: 'seeded-actions-first', sourceRevision: 'test' },
        })
        const second = yield* runInProcessScenario({
          scenario: seededTodoActions,
          application: todoApplication,
          options: { runId: 'seeded-actions-second', sourceRevision: 'test' },
        })
        const differentSeed = yield* runInProcessScenario({
          scenario: makeSeededTodoActions(seededTodoActions.seed + 1),
          application: todoApplication,
          options: { runId: 'seeded-actions-different-seed', sourceRevision: 'test' },
        })

        expect(first.status).toBe('passed')
        expect(second.status).toBe('passed')
        expect(differentSeed.status).toBe('passed')
        expect(generatedActionSignature(first)).toEqual(generatedActionSignature(second))
        expect(generatedActionSignature(first)).not.toEqual(generatedActionSignature(differentSeed))

        const sequence = first.scenario.instructions.find((instruction) => instruction._tag === 'action-sequence')
        expect(sequence?._tag).toBe('action-sequence')
        if (sequence?._tag !== 'action-sequence') return
        const requested = first.trace.find((record) => record.payload._tag === 'action-sequence.requested')
        const completed = first.trace.find((record) => record.payload._tag === 'action-sequence.completed')
        expect(requested?.payload).toEqual(expect.objectContaining({ _tag: 'action-sequence.requested', count: 40 }))
        expect(completed?.payload).toEqual(
          expect.objectContaining({
            _tag: 'action-sequence.completed',
            actionIds: Array.from({ length: 40 }, (_, index) => `${sequence.id}:${String(index + 1).padStart(4, '0')}`),
          }),
        )
        expect(
          first.trace.filter(
            (record) => record.payload._tag === 'action.requested' && record.causationId === sequence.id,
          ),
        ).toHaveLength(40)
        expect(
          deriveScenarioOperationHistory(first.trace).find((operation) => operation.operationId === sequence.id),
        ).toEqual(expect.objectContaining({ family: 'action-sequence', status: 'succeeded' }))
        const moments = derivePlaybackMoments({ scenario: first.scenario, trace: first.trace })
        expect(moments.filter((moment) => moment.kind === 'action-sequence')).toEqual([
          expect.objectContaining({ summary: expect.stringContaining('40 actions') }),
        ])
        expect(moments.filter((moment) => moment.kind === 'action')).toHaveLength(0)
      }).pipe(Vitest.withTestCtx(test)),
    20_000,
  )
})
