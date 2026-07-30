import { defineScenario } from '../model.ts'

const writer = { clientId: 'client-a', sessionId: 'session-a' } as const
const observer = { clientId: 'client-b', sessionId: 'session-b' } as const

/** Repeatedly toggles one pending writer's route before allowing final convergence. */
export const reconnectFlapping = defineScenario({
  version: 1,
  id: 'reconnect-flapping',
  description: 'A Client with one pending Event reconnects and disconnects repeatedly before final recovery.',
  tags: ['sync', 'correctness', 'disconnect', 'reconnect', 'flapping'],
  seed: 3003,
  applicationId: 'scenario-todo-app',
  requires: [],
  topology: {
    storeId: 'scenario-reconnect-flapping',
    clients: [
      { id: writer.clientId, sessions: [writer.sessionId], initiallyConnected: true },
      { id: observer.clientId, sessions: [observer.sessionId], initiallyConnected: true },
    ],
  },
  phases: [
    {
      id: 'create-pending-work',
      description: 'Create one offline write and one confirmed competing write.',
      steps: [
        { _tag: 'disconnect', id: 'disconnect-writer', clientId: writer.clientId },
        {
          _tag: 'action',
          id: 'offline-write',
          target: writer,
          action: 'createTodo',
          input: { id: 'offline-flap', text: 'Pending across route flaps' },
        },
        {
          _tag: 'action',
          id: 'online-write',
          target: observer,
          action: 'createTodo',
          input: { id: 'online-flap', text: 'Confirmed before route flaps' },
        },
        {
          _tag: 'settle',
          id: 'confirm-online-write',
          participants: [observer],
          healDisconnectedClients: [],
          timeoutMs: 10_000,
        },
      ],
    },
    {
      id: 'flap-route',
      description: 'Toggle the route three times without adding timing sleeps or extra Events.',
      steps: [
        { _tag: 'reconnect', id: 'reconnect-1', clientId: writer.clientId },
        { _tag: 'disconnect', id: 'disconnect-2', clientId: writer.clientId },
        { _tag: 'reconnect', id: 'reconnect-2', clientId: writer.clientId },
        { _tag: 'disconnect', id: 'disconnect-3', clientId: writer.clientId },
        { _tag: 'reconnect', id: 'reconnect-3', clientId: writer.clientId },
        {
          _tag: 'settle',
          id: 'settle-after-flapping',
          participants: [writer, observer],
          healDisconnectedClients: [],
          timeoutMs: 20_000,
        },
      ],
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [writer, observer] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [writer, observer] },
    {
      _tag: 'confirmed-eventlog-prefix',
      id: 'confirmed-prefix-preserved',
      participants: [writer, observer],
    },
    { _tag: 'state-convergence', id: 'state-converged', participants: [writer, observer], inspector: 'todos' },
    {
      _tag: 'state-contains-ids',
      id: 'writes-preserved',
      participants: [writer, observer],
      inspector: 'todos',
      expectedIds: ['offline-flap', 'online-flap'],
    },
  ],
})
