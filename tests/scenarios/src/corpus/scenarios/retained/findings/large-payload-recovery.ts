import { defineScenario } from '../../../../model.ts'
import { todoApplication } from '../../../applications/todo.ts'

const writer = { clientId: 'client-a', sessionId: 'session-a' } as const
const observer = { clientId: 'client-b', sessionId: 'session-b' } as const
const payloadBytes = Number(process.env.SCENARIO_PAYLOAD_BYTES ?? 899_643)
const settlementTimeoutMs = Number(process.env.SCENARIO_SETTLEMENT_TIMEOUT_MS ?? 30_000)

/** Probes the smallest observed local sync-cf payload failure boundary. */
export const largePayloadRecovery = defineScenario({
  version: 3,
  id: 'large-payload-recovery',
  description: `An Event with a ${payloadBytes}-byte string crosses offline storage and backend synchronization.`,
  tags: ['sync', 'correctness', 'known-failure', 'large-payload', 'buffer-boundary', `${payloadBytes}-bytes`],
  seed: 3002,
  applicationId: todoApplication.id,
  requires: [],
  topology: {
    storeId: 'scenario-large-payload-recovery',
    clients: [
      { id: writer.clientId, sessions: [writer.sessionId], initiallyConnected: true },
      { id: observer.clientId, sessions: [observer.sessionId], initiallyConnected: true },
    ],
  },
  instructions: [
    {
      _tag: 'annotation',
      id: 'commit-large-payload-offline',
      text: 'Commit the payload while Client A cannot reach the backend.',
    },
    { _tag: 'disconnect', id: 'disconnect-writer', clientId: writer.clientId },
    {
      _tag: 'action',
      id: 'commit-one-mib-payload',
      target: writer,
      action: 'createTodo',
      input: { id: 'large-payload', text: 'x'.repeat(payloadBytes) },
    },
    { _tag: 'reconnect', id: 'reconnect-writer', clientId: writer.clientId },
    {
      _tag: 'settle',
      id: 'settle-large-payload',
      participants: [writer, observer],
      healDisconnectedClients: [],
      timeoutMs: settlementTimeoutMs,
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: [writer, observer] },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: [writer, observer] },
    { _tag: 'state-convergence', id: 'state-converged', participants: [writer, observer], inspector: 'todos' },
    {
      _tag: 'state-contains-ids',
      id: 'large-payload-row-preserved',
      participants: [writer, observer],
      inspector: 'todos',
      expectedIds: ['large-payload'],
    },
  ],
})
