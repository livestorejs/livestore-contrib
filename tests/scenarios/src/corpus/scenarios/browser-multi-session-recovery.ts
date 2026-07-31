import { defineScenario } from '../../model.ts'
import { todoApplication } from '../applications/todo.ts'

const sessionA1 = { clientId: 'client-a', sessionId: 'session-a1' } as const
const sessionA2 = { clientId: 'client-a', sessionId: 'session-a2' } as const

/**
 * Exercises the persisted web topology rather than merely running a Store inside a page.
 * The fixture starts A1 before adding A2, so blocking Web Lock election makes A1 the initial Leader holder.
 */
export const browserMultiSessionRecovery = defineScenario({
  version: 1,
  id: 'browser-multi-session-recovery',
  description: 'A later browser session joins one Client leader and both recover through session and Client restarts.',
  tags: ['sync', 'browser', 'multi-session', 'opfs', 'lifecycle'],
  seed: 1443,
  applicationId: todoApplication.id,
  requires: [
    'multiple-sessions',
    'named-actions',
    'sync-observation',
    'state-inspection',
    'opfs-state',
    'session-restart',
    'client-restart',
    'dynamic-session-addition',
    'browser-shared-worker',
    'browser-web-locks',
  ],
  topology: {
    storeId: 'scenario-browser-multi-session-recovery',
    clients: [{ id: 'client-a', sessions: ['session-a1'], initiallyConnected: true }],
  },
  phases: [
    {
      id: 'shared-leader',
      description: 'Both sessions write through the same SharedWorker-backed Client leader.',
      steps: [
        {
          _tag: 'action',
          id: 'session-a1-write',
          target: sessionA1,
          action: 'createTodo',
          input: { id: 'todo-session-a1', text: 'Written by the first browser session' },
        },
        { _tag: 'add-session', id: 'add-session-a2', target: sessionA2 },
        {
          _tag: 'action',
          id: 'session-a2-write',
          target: sessionA2,
          action: 'createTodo',
          input: { id: 'todo-session-a2', text: 'Written by the second browser session' },
        },
        {
          _tag: 'settle',
          id: 'settle-shared-leader',
          participants: [sessionA1, sessionA2],
          healDisconnectedClients: [],
          timeoutMs: 15_000,
        },
      ],
    },
    {
      id: 'session-lifecycle',
      description:
        'The initial lock-holding page closes, its sibling continues through Leader turnover, then it returns.',
      steps: [
        { _tag: 'stop-session', id: 'stop-session-a1', target: sessionA1 },
        {
          _tag: 'action',
          id: 'session-a2-write-after-leader-turnover',
          target: sessionA2,
          action: 'createTodo',
          input: { id: 'todo-after-leader-turnover', text: 'Written after the initial Leader session closes' },
        },
        { _tag: 'restart-session', id: 'restart-session-a1', target: sessionA1 },
        {
          _tag: 'settle',
          id: 'settle-session-restart',
          participants: [sessionA1, sessionA2],
          healDisconnectedClients: [],
          timeoutMs: 15_000,
        },
      ],
    },
    {
      id: 'client-lifecycle',
      description: 'The entire browser Client restarts and restores both sessions from OPFS before converging.',
      steps: [
        { _tag: 'restart-client', id: 'restart-client-a', clientId: 'client-a' },
        {
          _tag: 'settle',
          id: 'settle-client-restart',
          participants: [sessionA1, sessionA2],
          healDisconnectedClients: [],
          timeoutMs: 20_000,
        },
      ],
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [sessionA1, sessionA2] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [sessionA1, sessionA2] },
    {
      _tag: 'confirmed-eventlog-prefix',
      id: 'confirmed-eventlogs-append-only',
      participants: [sessionA1, sessionA2],
    },
    {
      _tag: 'state-convergence',
      id: 'todo-state-converged',
      participants: [sessionA1, sessionA2],
      inspector: 'todos',
    },
    {
      _tag: 'state-contains-ids',
      id: 'no-todos-lost',
      participants: [sessionA1, sessionA2],
      inspector: 'todos',
      expectedIds: ['todo-session-a1', 'todo-session-a2', 'todo-after-leader-turnover'],
    },
  ],
})
