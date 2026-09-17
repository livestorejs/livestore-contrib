import { todo } from '../../corpus/applications/todo.ts'
import {
  alias,
  backendAvailable,
  backendUnavailable,
  client,
  eventlogsConverge,
  parallel,
  pendingResolved,
  Scenario,
  stateContainsIds,
  stateConverges,
  note,
} from '../../scenario.ts'

const clientA = client('client-a').withSessions('session-a')
const sessionA = clientA.session('session-a')
const clientB = client('client-b').withSessions('session-b')
const sessionB = clientB.session('session-b')
const both = alias([sessionA, sessionB])

export default Scenario.start({
  application: todo,
  about: 'Two Clients retain local writes while the backend route is unavailable, then recover and converge.',
  clients: [clientA, clientB],
})
  .steps(
    note('Remove the shared backend route and retain local writes on both Clients.'),
    backendUnavailable(),
    parallel([
      todo
        .createTodo({
          id: 'todo-outage-a',
          text: 'Written by Client A during the backend outage',
        })
        .as(sessionA),
      todo
        .createTodo({
          id: 'todo-outage-b',
          text: 'Written by Client B during the backend outage',
        })
        .as(sessionB),
    ]),
    backendAvailable(),
  )
  .expect(
    pendingResolved(both),
    eventlogsConverge(both),
    stateConverges('todos', both),
    stateContainsIds('todos', ['todo-outage-a', 'todo-outage-b'], both),
  )
