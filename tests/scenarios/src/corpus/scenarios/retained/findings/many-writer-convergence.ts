import { defineScenario, type ParticipantRef } from '../../../../model.ts'
import { todoApplication } from '../../../applications/todo.ts'

const writerCount = Number(process.env.SCENARIO_WRITER_COUNT ?? 2)
const eventCount = Number(process.env.SCENARIO_EVENT_COUNT ?? 426)
const writers: ReadonlyArray<ParticipantRef> = Array.from({ length: writerCount }, (_, index) => ({
  clientId: `client-${index + 1}`,
  sessionId: `session-${index + 1}`,
}))

/** Distributes hundreds of Events across many independently synchronizing Clients. */
export const manyWriterConvergence = defineScenario(({ repeatActions }) => ({
  version: 2,
  id: 'many-writer-convergence',
  description: `${writerCount} Clients distribute and converge ${eventCount} uniquely identified Events.`,
  tags: ['sync', 'correctness', 'known-failure', 'topology', 'many-writers', `${eventCount}-events`],
  seed: 3004,
  applicationId: todoApplication.id,
  requires: [],
  topology: {
    storeId: 'scenario-many-writer-convergence',
    clients: writers.map(({ clientId, sessionId }) => ({
      id: clientId,
      sessions: [sessionId],
      initiallyConnected: true,
    })),
  },
  phases: [
    {
      id: 'distribute-writes',
      description: 'Generate deterministic createTodo actions here and distribute them across all Clients.',
      steps: [
        repeatActions({
          id: 'many-writer-actions',
          description: `Distribute ${eventCount} unique writes across ${writerCount} Clients`,
          count: eventCount,
          generate: ({ iteration, random }) => ({
            target: random.pick('target', writers),
            action: 'createTodo',
            input: {
              id: `many-writer-${String(iteration + 1).padStart(3, '0')}`,
              text: `Distributed write ${iteration + 1} · variant ${random.integer('text-variant', 1_000)}`,
            },
          }),
        }),
        {
          _tag: 'settle',
          id: 'settle-many-writers',
          participants: writers,
          healDisconnectedClients: [],
          timeoutMs: 60_000,
        },
      ],
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: writers },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: writers },
    { _tag: 'confirmed-eventlog-prefix', id: 'confirmed-prefix-preserved', participants: writers },
    { _tag: 'state-convergence', id: 'state-converged', participants: writers, inspector: 'todos' },
    {
      _tag: 'state-contains-ids',
      id: 'boundary-items-preserved',
      participants: writers,
      inspector: 'todos',
      expectedIds: ['many-writer-001', `many-writer-${String(eventCount).padStart(3, '0')}`],
    },
  ],
}))
