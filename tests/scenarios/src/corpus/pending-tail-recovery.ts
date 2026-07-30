import { defineScenario } from '../model.ts'

const offlineWriter = { clientId: 'client-a', sessionId: 'session-a' } as const
const onlineWriter = { clientId: 'client-b', sessionId: 'session-b' } as const
const pendingCount = Number(process.env.SCENARIO_PENDING_COUNT ?? 400)
const settlementTimeoutMs = Number(process.env.SCENARIO_SETTLEMENT_TIMEOUT_MS ?? 60_000)

/** Reconciles a pending tail over confirmed remote history at the smallest observed stall boundary. */
export const pendingTailRecovery = defineScenario({
  version: 1,
  id: 'pending-tail-recovery',
  description: `An offline Client rebases ${pendingCount} pending Events over one confirmed remote Event.`,
  tags: ['sync', 'correctness', 'known-failure', 'pending-tail', 'rebase', `${pendingCount}-events`],
  seed: 3001,
  applicationId: 'scenario-todo-app',
  requires: [],
  topology: {
    storeId: 'scenario-pending-tail-recovery',
    clients: [
      { id: offlineWriter.clientId, sessions: [offlineWriter.sessionId], initiallyConnected: true },
      { id: onlineWriter.clientId, sessions: [onlineWriter.sessionId], initiallyConnected: true },
    ],
  },
  phases: [
    {
      id: 'build-pending-tail',
      description: 'Client A accumulates a large pending tail while Client B confirms independent history.',
      steps: [
        { _tag: 'disconnect', id: 'disconnect-offline-writer', clientId: offlineWriter.clientId },
        {
          _tag: 'workload',
          id: 'offline-pending-tail',
          workload: 'createTodoBurst',
          input: { idPrefix: 'pending', textPrefix: 'Offline pending item' },
          targets: [offlineWriter],
          count: pendingCount,
        },
        {
          _tag: 'action',
          id: 'confirmed-remote-write',
          target: onlineWriter,
          action: 'createTodo',
          input: { id: 'remote-confirmed', text: 'Confirmed ahead of the pending tail' },
        },
        {
          _tag: 'settle',
          id: 'confirm-remote-write',
          participants: [onlineWriter],
          healDisconnectedClients: [],
          timeoutMs: 10_000,
        },
      ],
    },
    {
      id: 'reconcile-pending-tail',
      description: 'Client A reconnects and rebases its pending tail over the confirmed remote write.',
      steps: [
        { _tag: 'reconnect', id: 'reconnect-offline-writer', clientId: offlineWriter.clientId },
        {
          _tag: 'settle',
          id: 'settle-pending-tail',
          participants: [offlineWriter, onlineWriter],
          healDisconnectedClients: [],
          timeoutMs: settlementTimeoutMs,
        },
      ],
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [offlineWriter, onlineWriter] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [offlineWriter, onlineWriter] },
    {
      _tag: 'confirmed-eventlog-prefix',
      id: 'confirmed-prefix-preserved',
      participants: [offlineWriter, onlineWriter],
    },
    {
      _tag: 'state-convergence',
      id: 'todo-state-converged',
      participants: [offlineWriter, onlineWriter],
      inspector: 'todos',
    },
    {
      _tag: 'state-contains-ids',
      id: 'boundary-items-preserved',
      participants: [offlineWriter, onlineWriter],
      inspector: 'todos',
      expectedIds: ['pending-001', `pending-${pendingCount}`, 'remote-confirmed'],
    },
  ],
})
