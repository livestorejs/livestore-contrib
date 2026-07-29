import { defineScenario } from '../model.ts'

const offlineWriter = { clientId: 'client-a', sessionId: 'session-a' } as const
const onlineWriter = { clientId: 'client-b', sessionId: 'session-b' } as const
const participants = [offlineWriter, onlineWriter]

/**
 * Minimal reproduction of the command-replay RFC's invalid-rebase class:
 * both Clients validly decrement 1 to 0 in their own context, but replaying
 * Client A's pending event after Client B's confirmed event attempts 0 to -1.
 */
export const concurrentDecrementRebase = defineScenario({
  version: 1,
  id: 'concurrent-decrement-rebase',
  description: 'Rebase two locally valid decrements into a SQLite-enforced non-negative invariant violation.',
  tags: ['red-team', 'known-failure', 'rebase', 'materialization', 'sqlite-constraint'],
  seed: 2_002,
  applicationId: 'scenario-todo-app',
  requires: [],
  topology: {
    storeId: 'concurrent-decrement-rebase',
    clients: [
      { id: offlineWriter.clientId, sessions: [offlineWriter.sessionId], initiallyConnected: true },
      { id: onlineWriter.clientId, sessions: [onlineWriter.sessionId], initiallyConnected: true },
    ],
  },
  phases: [
    {
      id: 'establish-shared-base',
      description: 'Both Clients confirm that one room remains available.',
      steps: [
        {
          _tag: 'action',
          id: 'initialize-one-available-room',
          target: onlineWriter,
          action: 'initializeRoomAvailability',
          input: { roomId: 'room-1', available: 1 },
        },
        {
          _tag: 'settle',
          id: 'confirm-shared-base',
          participants,
          healDisconnectedClients: [],
          timeoutMs: 10_000,
        },
      ],
    },
    {
      id: 'create-concurrent-decrements',
      description: 'Each Client independently performs the locally valid transition from one to zero.',
      steps: [
        { _tag: 'disconnect', id: 'isolate-client-a', clientId: offlineWriter.clientId },
        {
          _tag: 'action',
          id: 'client-a-decrements-offline',
          target: offlineWriter,
          action: 'decrementAvailableRoom',
          input: { roomId: 'room-1' },
        },
        {
          _tag: 'action',
          id: 'client-b-decrements-online',
          target: onlineWriter,
          action: 'decrementAvailableRoom',
          input: { roomId: 'room-1' },
        },
        {
          _tag: 'settle',
          id: 'confirm-client-b-decrement',
          participants: [onlineWriter],
          healDisconnectedClients: [],
          timeoutMs: 10_000,
        },
      ],
    },
    {
      id: 'rebase-invalid-pending-event',
      description: 'Client A rebases its decrement over Client B and attempts to materialize minus one.',
      steps: [
        { _tag: 'reconnect', id: 'reconnect-client-a', clientId: offlineWriter.clientId },
        {
          _tag: 'settle',
          id: 'observe-materialization-failure',
          participants,
          healDisconnectedClients: [],
          timeoutMs: 10_000,
        },
      ],
    },
  ],
  oracles: [],
})
