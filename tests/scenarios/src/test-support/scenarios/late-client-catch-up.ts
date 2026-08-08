import { todoApplication } from '../../corpus/applications/todo.ts'
import { defineScenario } from '../../model.ts'

const clientA = { clientId: 'client-a', sessionId: 'session-a' } as const
const clientB = { clientId: 'client-b', sessionId: 'session-b' } as const
const historyCount = 8

/** Creates a Client only after the backend has history, then writes while its catch-up is still settling. */
export const lateClientCatchUp = defineScenario(({ repeatActions }) => ({
  version: 2,
  id: 'late-client-catch-up',
  description: 'A new Client starts from empty local state after history exists, writes, and converges.',
  tags: ['sync', 'topology', 'late-join', 'catch-up'],
  seed: 1446,
  applicationId: todoApplication.id,
  requires: ['named-actions', 'sync-observation', 'state-inspection', 'dynamic-client-creation'],
  topology: {
    storeId: 'scenario-late-client-catch-up',
    clients: [{ id: clientA.clientId, sessions: [clientA.sessionId], initiallyConnected: true }],
  },
  phases: [
    {
      id: 'establish-history',
      description: 'The initial Client commits and confirms history before the second Client exists.',
      steps: [
        repeatActions({
          id: 'initial-history',
          description: 'Create the initial history before Client B exists',
          count: historyCount,
          generate: ({ iteration, random }) => ({
            target: clientA,
            action: 'createTodo',
            input: {
              id: `history-${String(iteration + 1).padStart(3, '0')}`,
              text: `Before the late Client ${iteration + 1} · variant ${random.integer('text-variant', 1_000)}`,
            },
          }),
        }),
        {
          _tag: 'settle',
          id: 'settle-initial-history',
          participants: [clientA],
          healDisconnectedClients: [],
          timeoutMs: 8_000,
        },
      ],
    },
    {
      id: 'late-join',
      description: 'Client B is created from empty local state and both Clients write before final settlement.',
      steps: [
        {
          _tag: 'create-client',
          id: 'create-client-b',
          client: { id: clientB.clientId, sessions: [clientB.sessionId], initiallyConnected: true },
        },
        {
          _tag: 'parallel',
          id: 'writes-after-join',
          operations: [
            {
              _tag: 'action',
              id: 'client-a-after-join',
              target: clientA,
              action: 'createTodo',
              input: { id: 'after-join-a', text: 'Written by the established Client' },
            },
            {
              _tag: 'action',
              id: 'client-b-first-write',
              target: clientB,
              action: 'createTodo',
              input: { id: 'after-join-b', text: 'Written by the late Client' },
            },
          ],
        },
        {
          _tag: 'settle',
          id: 'settle-late-client',
          participants: [clientA, clientB],
          healDisconnectedClients: [],
          timeoutMs: 15_000,
        },
      ],
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [clientA, clientB] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [clientA, clientB] },
    { _tag: 'state-convergence', id: 'todo-state-converged', participants: [clientA, clientB], inspector: 'todos' },
    {
      _tag: 'state-contains-ids',
      id: 'late-client-has-complete-state',
      participants: [clientA, clientB],
      inspector: 'todos',
      expectedIds: [
        ...Array.from({ length: historyCount }, (_, index) => `history-${String(index + 1).padStart(3, '0')}`),
        'after-join-a',
        'after-join-b',
      ],
    },
  ],
}))
