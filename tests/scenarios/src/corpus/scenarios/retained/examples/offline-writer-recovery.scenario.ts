import {
  Scenario,
  alias,
  client,
  disconnect,
  eventlogsConverge,
  note,
  parallel,
  pendingResolved,
  reconnect,
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

export default Scenario.start({
  application: todo,
  about: 'An offline Client and an online Client both write before reconnecting and converging.',
  clients: [clientA, clientB],
})
  .steps(
    note('Client A writes offline while Client B writes against the shared backend.'),
    disconnect(clientA),
    parallel(
      [
        todo.createTodo({ id: 'todo-offline-a', text: 'Written while Client A is offline' }).as(sessionA),
        todo.createTodo({ id: 'todo-online-b', text: 'Written while Client B is online' }).as(sessionB),
      ],
      { require: 'overlap' },
    ),
    settle(sessionB),
    note('Client A reconnects before the final expectations establish a stable shared head.'),
    reconnect(clientA),
  )
  .expect(
    pendingResolved(both),
    eventlogsConverge(both),
    stateConverges('todos', both),
    stateContainsIds('todos', ['todo-offline-a', 'todo-online-b'], both),
  )
