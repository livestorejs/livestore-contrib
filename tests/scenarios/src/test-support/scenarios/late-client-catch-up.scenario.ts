import { todo } from '../../corpus/applications/todo.ts'
import {
  alias,
  client,
  createClient,
  eventlogsConverge,
  note,
  pad,
  parallel,
  parameter,
  pendingResolved,
  repeat,
  Scenario,
  settle,
  stateContainsIds,
  stateConverges,
} from '../../scenario.ts'

const clientA = client('client-a').withSessions('session-a')
const sessionA = clientA.session('session-a')
const clientB = client('client-b').withSessions('session-b')
const sessionB = clientB.session('session-b')
const both = alias([sessionA, sessionB])

export default Scenario.parameterized({ history_count: parameter.integer(8) }, ({ history_count: historyCount }) => {
  const historyIds = Array.from({ length: historyCount }, (_, offset) => `history-${pad(offset + 1, 3)}`)

  return Scenario.start({
    application: todo,
    seed: 1446,
    about: 'A new Client starts from empty local state after history exists, writes, and converges.',
    clients: [clientA],
  })
    .steps(
      note('The initial Client commits and confirms history before the second Client exists.'),
      repeat(
        historyIds.map((id, offset) =>
          todo.createTodo({ id, text: `Before the late Client ${offset + 1}` }).as(sessionA),
        ),
      ),
      settle(sessionA),
      note('Client B is created from empty local state and both Clients write before final stabilization.'),
      createClient(clientB),
      parallel([
        todo.createTodo({ id: 'after-join-a', text: 'Written by the established Client' }).as(sessionA),
        todo.createTodo({ id: 'after-join-b', text: 'Written by the late Client' }).as(sessionB),
      ]),
    )
    .expect(
      pendingResolved(both),
      eventlogsConverge(both),
      stateConverges('todos', both),
      stateContainsIds('todos', [...historyIds, 'after-join-a', 'after-join-b'], both),
    )
})
