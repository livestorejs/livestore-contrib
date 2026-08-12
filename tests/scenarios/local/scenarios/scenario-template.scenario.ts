import { todo } from '../../src/corpus/applications/todo.ts'
import { client, eventlogsConverge, expect, pendingResolved, Scenario } from '../../src/scenario.ts'

const clientA = client('client-a').withSessions('main')
const main = clientA.session('main')

export default Scenario.start({
  application: todo,
  about: 'Describe the behavior or hypothesis this Scenario exercises.',
  clients: [clientA],
}).pipe(
  // Add ordered instructions here.
  todo.createTodo({ id: 'todo-1', text: 'Replace this example action' }).as(main),
  expect(pendingResolved(), eventlogsConverge()),
)
