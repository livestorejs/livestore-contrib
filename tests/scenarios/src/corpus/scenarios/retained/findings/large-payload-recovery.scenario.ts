import {
  Scenario,
  alias,
  client,
  disconnect,
  eventlogsConverge,
  generate,
  note,
  parameter,
  pendingResolved,
  reconnect,
  stateContainsIds,
  stateConverges,
} from '../../../../scenario.ts'
import { todo } from '../../../applications/todo.ts'

const clientA = client('client-a').withSessions('session-a')
const clientB = client('client-b').withSessions('session-b')
const sessionA = clientA.session('session-a')
const sessionB = clientB.session('session-b')
const both = alias([sessionA, sessionB])

export default Scenario.parameterized(
  { payload_bytes: parameter.integer(899_643) },
  ({ payload_bytes: payloadBytes }) =>
    Scenario.start({
      application: todo,
      about: `An Event with a ${payloadBytes}-byte string crosses offline storage and backend synchronization.`,
      clients: [clientA, clientB],
    })
      .steps(
        note('Commit the payload while Client A cannot reach the backend.'),
        disconnect(clientA),
        generate([todo.createTodo({ id: 'large-payload', text: 'x'.repeat(payloadBytes) }).as(sessionA)], {
          description: 'Generate largeStringAction (1 actions)',
        }),
        reconnect(clientA),
      )
      .expect(
        pendingResolved(both),
        eventlogsConverge(both),
        stateConverges('todos', both),
        stateContainsIds('todos', ['large-payload'], both),
      ),
)
