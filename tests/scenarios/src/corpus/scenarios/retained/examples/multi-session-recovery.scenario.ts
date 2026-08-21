import {
  Scenario,
  addSession,
  alias,
  client,
  eventlogsConverge,
  note,
  pendingResolved,
  restartClient,
  restartSession,
  settle,
  stateContainsIds,
  stateConverges,
  stopSession,
} from '../../../../scenario.ts'
import { todo } from '../../../applications/todo.ts'

const clientA = client('client-a').withSessions('session-a1')
const sessionA1 = clientA.session('session-a1')
const sessionA2 = clientA.session('session-a2')
const both = alias([sessionA1, sessionA2])

export default Scenario.start({
  application: todo,
  about: 'A later session joins one Client leader and both recover through session and Client restarts.',
  clients: [clientA],
})
  .steps(
    note('Both sessions write through the same Client leader.'),
    todo.createTodo({ id: 'todo-session-a1', text: 'Written by the first session' }).as(sessionA1),
    addSession(sessionA2),
    todo.createTodo({ id: 'todo-session-a2', text: 'Written by the second session' }).as(sessionA2),
    settle(both),
    note('The first session stops, its sibling continues through Leader turnover, then it returns.'),
    stopSession(sessionA1),
    todo
      .createTodo({
        id: 'todo-after-leader-turnover',
        text: 'Written after the initial Leader session closes',
      })
      .as(sessionA2),
    restartSession(sessionA1),
    settle(both),
    note('The entire Client restarts and restores both sessions before converging.'),
    restartClient(clientA),
  )
  .expect(
    pendingResolved(both),
    eventlogsConverge(both),
    stateConverges('todos', both),
    stateContainsIds('todos', ['todo-session-a1', 'todo-session-a2', 'todo-after-leader-turnover'], both),
  )
