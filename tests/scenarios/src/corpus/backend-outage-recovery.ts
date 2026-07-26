import { defineScenario } from '../model.ts'

const clientA = { clientId: 'client-a', sessionId: 'session-a' } as const
const clientB = { clientId: 'client-b', sessionId: 'session-b' } as const

/** Exercises a shared upstream outage while both Clients remain locally writable. */
export const backendOutageRecovery = defineScenario({
  version: 1,
  id: 'backend-outage-recovery',
  description: 'Two Clients retain local writes while the backend route is unavailable, then recover and converge.',
  tags: ['sync', 'fault', 'backend-availability', 'recovery'],
  seed: 1444,
  applicationId: 'scenario-todo-app',
  requires: [],
  topology: {
    storeId: 'scenario-backend-outage-recovery',
    clients: [
      { id: clientA.clientId, sessions: [clientA.sessionId], initiallyConnected: true },
      { id: clientB.clientId, sessions: [clientB.sessionId], initiallyConnected: true },
    ],
  },
  phases: [
    {
      id: 'backend-outage',
      description: 'Remove the shared backend route and retain local writes on both Clients.',
      steps: [
        { _tag: 'backend-unavailable', id: 'backend-outage-started' },
        {
          _tag: 'parallel',
          id: 'writes-during-backend-outage',
          operations: [
            {
              _tag: 'action',
              id: 'client-a-outage-write',
              target: clientA,
              action: 'createTodo',
              input: { id: 'todo-outage-a', text: 'Written by Client A during the backend outage' },
            },
            {
              _tag: 'action',
              id: 'client-b-outage-write',
              target: clientB,
              action: 'createTodo',
              input: { id: 'todo-outage-b', text: 'Written by Client B during the backend outage' },
            },
          ],
        },
        { _tag: 'backend-available', id: 'backend-outage-ended' },
        {
          _tag: 'settle',
          id: 'settle-after-backend-recovery',
          participants: [clientA, clientB],
          healDisconnectedClients: [],
          timeoutMs: 20_000,
        },
      ],
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'all-pending-resolved', participants: [clientA, clientB] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [clientA, clientB] },
    {
      _tag: 'state-convergence',
      id: 'states-converged',
      participants: [clientA, clientB],
      inspector: 'todos',
    },
    {
      _tag: 'state-contains-ids',
      id: 'outage-writes-preserved',
      participants: [clientA, clientB],
      inspector: 'todos',
      expectedIds: ['todo-outage-a', 'todo-outage-b'],
    },
  ],
})
