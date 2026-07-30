import { defineScenario } from '../model.ts'

const writer = { clientId: 'client-a', sessionId: 'session-a' } as const
const pendingCount = Number(process.env.SCENARIO_PENDING_COUNT ?? 400)
const settlementTimeoutMs = Number(process.env.SCENARIO_SETTLEMENT_TIMEOUT_MS ?? 60_000)

/** Minimal one-Client probe for draining a large pending queue after reconnect. */
export const pendingPushBoundary = defineScenario({
  version: 1,
  id: 'pending-push-boundary',
  description: 'One disconnected Client commits a pending Event sequence, reconnects, and attempts to drain it.',
  tags: ['sync', 'correctness', 'pending-tail', 'push-boundary'],
  seed: 3005,
  applicationId: 'scenario-todo-app',
  requires: [],
  topology: {
    storeId: 'scenario-pending-push-boundary',
    clients: [{ id: writer.clientId, sessions: [writer.sessionId], initiallyConnected: true }],
  },
  phases: [
    {
      id: 'build-and-drain-pending-tail',
      description: 'Create the pending sequence without remote history, then reconnect once.',
      steps: [
        { _tag: 'disconnect', id: 'disconnect-writer', clientId: writer.clientId },
        {
          _tag: 'workload',
          id: 'offline-pending-tail',
          workload: 'createTodoBurst',
          input: { idPrefix: 'pending', textPrefix: 'Offline pending item' },
          targets: [writer],
          count: pendingCount,
        },
        { _tag: 'reconnect', id: 'reconnect-writer', clientId: writer.clientId },
        {
          _tag: 'settle',
          id: 'settle-pending-tail',
          participants: [writer],
          healDisconnectedClients: [],
          timeoutMs: settlementTimeoutMs,
        },
      ],
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [writer] },
    { _tag: 'eventlog-convergence', id: 'eventlog-converged', participants: [writer] },
    { _tag: 'confirmed-eventlog-prefix', id: 'confirmed-prefix-preserved', participants: [writer] },
    {
      _tag: 'state-contains-ids',
      id: 'boundary-items-preserved',
      participants: [writer],
      inspector: 'todos',
      expectedIds: ['pending-001', `pending-${pendingCount}`],
    },
  ],
})
