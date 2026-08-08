import { defineScenario } from '../../../../model.ts'
import { todoApplication } from '../../../applications/todo.ts'

const clientA = { clientId: 'client-a', sessionId: 'session-a' } as const
const clientB = { clientId: 'client-b', sessionId: 'session-b' } as const

export const offlineWriterRecovery = defineScenario({
  version: 3,
  id: 'offline-writer-recovery',
  description: 'An offline Client and an online Client both write before reconnecting and converging.',
  tags: ['sync', 'offline', 'rebase'],
  seed: 1442,
  applicationId: todoApplication.id,
  requires: ['multiple-clients', 'named-actions', 'disconnect-reconnect', 'sync-observation', 'state-inspection'],
  topology: {
    storeId: 'scenario-offline-writer-recovery',
    clients: [
      { id: clientA.clientId, sessions: [clientA.sessionId], initiallyConnected: true },
      { id: clientB.clientId, sessions: [clientB.sessionId], initiallyConnected: true },
    ],
  },
  instructions: [
    {
      _tag: 'annotation',
      id: 'offline-and-concurrent-writes',
      text: 'Client A writes offline while Client B writes against the shared backend.',
    },
    { _tag: 'disconnect', id: 'disconnect-client-a', clientId: clientA.clientId },
    {
      _tag: 'parallel',
      id: 'concurrent-writes',
      operations: [
        {
          _tag: 'action',
          id: 'client-a-offline-write',
          target: clientA,
          action: 'createTodo',
          input: { id: 'todo-offline-a', text: 'Written while Client A is offline' },
        },
        {
          _tag: 'action',
          id: 'client-b-online-write',
          target: clientB,
          action: 'createTodo',
          input: { id: 'todo-online-b', text: 'Written while Client B is online' },
        },
      ],
    },
    {
      _tag: 'settle',
      id: 'settle-online-client',
      participants: [clientB],
      healDisconnectedClients: [],
      timeoutMs: 3_000,
    },
    {
      _tag: 'annotation',
      id: 'recovery',
      text: 'Settlement heals Client A and waits for a stable shared head.',
    },
    {
      _tag: 'settle',
      id: 'settle-after-reconnect',
      participants: [clientA, clientB],
      healDisconnectedClients: [clientA.clientId],
      timeoutMs: 8_000,
    },
  ],
  oracles: [
    {
      _tag: 'operation-history',
      id: 'writes-overlapped',
      operationIds: ['client-a-offline-write', 'client-b-online-write'],
      requireOverlap: true,
      allowIndefinite: false,
    },
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [clientA, clientB] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [clientA, clientB] },
    {
      _tag: 'confirmed-eventlog-prefix',
      id: 'confirmed-eventlogs-append-only',
      participants: [clientA, clientB],
    },
    {
      _tag: 'state-convergence',
      id: 'todo-state-converged',
      participants: [clientA, clientB],
      inspector: 'todos',
    },
    {
      _tag: 'state-contains-ids',
      id: 'no-todos-lost',
      participants: [clientA, clientB],
      inspector: 'todos',
      expectedIds: ['todo-offline-a', 'todo-online-b'],
    },
  ],
})
