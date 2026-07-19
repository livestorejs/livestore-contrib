import { Events, makeSchema, State } from '@livestore/common/schema'
import { Effect, Schema } from '@livestore/utils/effect'

import { defineAction, defineApplication, defineInspector } from '../application.ts'

export const todoEvents = {
  created: Events.synced({
    name: 'v1.TodoCreated',
    schema: Schema.Struct({ id: Schema.String, text: Schema.String }),
  }),
}

export const todosTable = State.SQLite.table({
  name: 'todos',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    text: State.SQLite.text({ nullable: false }),
    completed: State.SQLite.boolean({ default: false, nullable: false }),
  },
})

const materializers = State.SQLite.materializers(todoEvents, {
  'v1.TodoCreated': ({ id, text }) => todosTable.insert({ id, text, completed: false }),
})

export const todoSchema = makeSchema({
  events: todoEvents,
  state: State.SQLite.makeState({ tables: { todos: todosTable }, materializers }),
})

const TodoActionInput = Schema.Struct({ id: Schema.String, text: Schema.String })
const TodoRows = Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String, completed: Schema.Boolean }))

export const todoApplication = defineApplication({
  id: 'scenario-todo-app',
  schema: todoSchema,
  actions: {
    createTodo: defineAction<typeof todoSchema, typeof TodoActionInput>({
      input: TodoActionInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(todoEvents.created(input))),
    }),
  },
  inspectors: {
    todos: defineInspector<typeof todoSchema, typeof TodoRows>({
      output: TodoRows,
      read: ({ store }) => store.query(todosTable).toSorted((left, right) => left.id.localeCompare(right.id)),
    }),
  },
})
