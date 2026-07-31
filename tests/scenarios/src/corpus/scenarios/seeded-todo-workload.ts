import { defineScenario } from '../../model.ts'
import { todoApplication } from '../applications/todo.ts'

const clientA = { clientId: 'client-a', sessionId: 'session-a' } as const
const clientB = { clientId: 'client-b', sessionId: 'session-b' } as const
const workloadCount = 12

/** Keeps a generated multi-Client workload compact while retaining every emitted action in the trace. */
export const seededTodoWorkload = defineScenario({
  version: 1,
  id: 'seeded-todo-workload',
  description: 'A named seeded workload distributes unique todo creation across two Clients and then converges.',
  tags: ['sync', 'workload', 'seeded', 'multiple-clients'],
  seed: 1445,
  applicationId: todoApplication.id,
  requires: [],
  topology: {
    storeId: 'scenario-seeded-todo-workload',
    clients: [
      { id: clientA.clientId, sessions: [clientA.sessionId], initiallyConnected: true },
      { id: clientB.clientId, sessions: [clientB.sessionId], initiallyConnected: true },
    ],
  },
  phases: [
    {
      id: 'generated-work',
      description: 'Expand one compact workload node from the Scenario seed and dispatch its generated actions.',
      steps: [
        {
          _tag: 'workload',
          id: 'create-seeded-todos',
          workload: 'createTodoBurst',
          input: { idPrefix: 'seeded-todo', textPrefix: 'Seeded task' },
          targets: [clientA, clientB],
          count: workloadCount,
        },
        {
          _tag: 'settle',
          id: 'settle-seeded-workload',
          participants: [clientA, clientB],
          healDisconnectedClients: [],
          timeoutMs: 8_000,
        },
      ],
    },
  ],
  oracles: [
    {
      _tag: 'operation-history',
      id: 'workload-completed',
      operationIds: ['create-seeded-todos'],
      requireOverlap: false,
      allowIndefinite: false,
    },
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [clientA, clientB] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [clientA, clientB] },
    {
      _tag: 'state-convergence',
      id: 'todo-state-converged',
      participants: [clientA, clientB],
      inspector: 'todos',
    },
    {
      _tag: 'state-contains-ids',
      id: 'generated-todos-preserved',
      participants: [clientA, clientB],
      inspector: 'todos',
      expectedIds: Array.from(
        { length: workloadCount },
        (_, index) => `seeded-todo-${String(index + 1).padStart(3, '0')}`,
      ),
    },
  ],
})
