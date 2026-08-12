import { todo } from '../../corpus/applications/todo.ts'
import { client, generate, note, Scenario } from '../../scenario.ts'

const clientA = client('client-a').withSessions('session-a')
const sessionA = clientA.session('session-a')

export default Scenario.start({
  application: todo,
  seed: 1445,
  about: 'A seeded Scenario expands readable TypeScript into concrete todo actions.',
  clients: [clientA],
}).pipe(
  note('Generate concrete createTodo actions here in the Scenario and dispatch them in order.'),
  generate(
    ({ random }) =>
      Array.from({ length: 40 }, (_, offset) => {
        const item = offset + 1
        return todo
          .createTodo({
            id: `seeded-todo-${pad(item, 3)}`,
            text: `Seeded task ${item} · variant ${random.iteration(item).integer('text-variant', 1_000)}`,
          })
          .as(sessionA)
      }),
    { description: 'Generate seededTodoActions (40 actions)', expect: 'all-finish' },
  ),
)

const pad = (value: number, width: number): string => String(value).padStart(width, '0')
