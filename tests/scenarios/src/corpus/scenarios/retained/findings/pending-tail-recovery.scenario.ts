import {
  Scenario,
  alias,
  client,
  disconnect,
  eventlogsConverge,
  note,
  pad,
  parameter,
  pendingResolved,
  reconnect,
  repeat,
  settle,
  stateContainsIds,
  stateConverges,
} from '../../../../scenario.ts'
import { todo } from '../../../applications/todo.ts'

const clientA = client('client-a').withSessions('session-a')
const clientB = client('client-b').withSessions('session-b')
const sessionA = clientA.session('session-a')
const sessionB = clientB.session('session-b')
const both = alias([sessionA, sessionB])

export default Scenario.parameterized({ pending_count: parameter.integer(400) }, ({ pending_count: pendingCount }) =>
  Scenario.start({
    application: todo,
    seed: 3001,
    about: `An offline Client rebases ${pendingCount} pending Events over one confirmed remote Event.`,
    clients: [clientA, clientB],
  })
    .steps(
      note('Client A accumulates a large pending tail while Client B confirms independent history.'),
      disconnect(clientA),
      repeat(
        Array.from({ length: pendingCount }, (_, offset) => {
          const item = offset + 1
          return todo.createTodo({ id: `pending-${pad(item, 3)}`, text: `Offline pending item ${item}` }).as(sessionA)
        }),
      ),
      todo.createTodo({ id: 'remote-confirmed', text: 'Confirmed ahead of the pending tail' }).as(sessionB),
      settle(sessionB),
      note('Client A reconnects and rebases its pending tail over the confirmed remote write.'),
      reconnect(clientA),
    )
    .expect(
      pendingResolved(both),
      eventlogsConverge(both),
      stateConverges('todos', both),
      stateContainsIds('todos', ['pending-001', `pending-${pad(pendingCount, 3)}`, 'remote-confirmed'], both),
    ),
)
