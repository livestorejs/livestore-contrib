import {
  Scenario,
  alias,
  client,
  eventlogsConverge,
  expect,
  generate,
  note,
  pad,
  parameter,
  pendingResolved,
  stateContainsIds,
  stateConverges,
} from '../../../../scenario.ts'
import { todo } from '../../../applications/todo.ts'

const client1 = client('client-1').withSessions('session-1')
const client2 = client('client-2').withSessions('session-2')
const session1 = client1.session('session-1')
const session2 = client2.session('session-2')
const writers = alias([session1, session2])

export default Scenario.parameterized({ event_count: parameter.integer(426) }, ({ event_count: eventCount }) =>
  Scenario.start({
    application: todo,
    seed: 3004,
    about: `Two Clients distribute and converge ${eventCount} uniquely identified Events.`,
    clients: [client1, client2],
  }).pipe(
    note('Generate deterministic createTodo actions here and distribute them across all Clients.'),
    generate(
      ({ random }) =>
        Array.from({ length: eventCount }, (_, offset) => {
          const event = offset + 1
          const iteration = random.iteration(event)
          return todo
            .createTodo({
              id: `many-writer-${pad(event, 3)}`,
              text: `Distributed write ${event} · variant ${iteration.integer('text-variant', 1_000)}`,
            })
            .as(iteration.pick('target', writers.members))
        }),
      { description: `Generate distributedTodos (${eventCount} actions)` },
    ),
    expect(
      pendingResolved(writers),
      eventlogsConverge(writers),
      stateConverges('todos', writers),
      stateContainsIds('todos', ['many-writer-001', `many-writer-${pad(eventCount, 3)}`], writers),
    ),
  ),
)
