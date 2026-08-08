import { todoApplication } from '../../corpus/applications/todo.ts'
import { defineScenario } from '../../model.ts'

const clientA = { clientId: 'client-a', sessionId: 'session-a' } as const
const actionCount = 40

/** Small fixture proving that Scenario-owned repetition expands to concrete actions. */
export const makeSeededTodoActions = (seed = 1445) =>
  defineScenario(({ repeatActions }) => ({
    version: 2,
    id: 'seeded-todo-actions',
    description: 'A seeded Scenario expands a readable repetition into concrete todo actions.',
    tags: ['generated-actions', 'seeded'],
    seed,
    applicationId: todoApplication.id,
    requires: [],
    topology: {
      storeId: 'scenario-seeded-todo-actions',
      clients: [{ id: clientA.clientId, sessions: [clientA.sessionId], initiallyConnected: true }],
    },
    phases: [
      {
        id: 'generated-work',
        description: 'Generate concrete createTodo actions here in the Scenario and dispatch them in order.',
        steps: [
          repeatActions({
            id: 'create-seeded-todos',
            description: 'Create forty seeded todos for generated-action and dense-viewer coverage',
            count: actionCount,
            generate: ({ iteration, random }) => ({
              target: clientA,
              action: 'createTodo',
              input: {
                id: `seeded-todo-${String(iteration + 1).padStart(3, '0')}`,
                text: `Seeded task ${iteration + 1} · variant ${random.integer('text-variant', 1_000)}`,
              },
            }),
          }),
        ],
      },
    ],
    oracles: [
      {
        _tag: 'operation-history',
        id: 'generated-actions-completed',
        operationIds: ['create-seeded-todos'],
        requireOverlap: false,
        allowIndefinite: false,
      },
    ],
  }))

export const seededTodoActions = makeSeededTodoActions()
export default seededTodoActions
