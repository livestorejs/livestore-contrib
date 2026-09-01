import { Events, makeSchema, State } from '@livestore/common/schema'
import { Effect, Schema } from '@livestore/utils/effect'

import { defineAction, defineApplication, defineInspector } from '../../application/definition.ts'
import { scenarioApplication } from '../../scenario.ts'

export const todoEvents = {
  created: Events.synced({
    name: 'v1.TodoCreated',
    schema: Schema.Struct({ id: Schema.String, text: Schema.String }),
  }),
  textChanged: Events.synced({
    name: 'v1.TodoTextChanged',
    schema: Schema.Struct({ id: Schema.String, text: Schema.String }),
  }),
  completionChanged: Events.synced({
    name: 'v1.TodoCompletionChanged',
    schema: Schema.Struct({ id: Schema.String, completed: Schema.Boolean }),
  }),
  deleted: Events.synced({
    name: 'v1.TodoDeleted',
    schema: Schema.Struct({ id: Schema.String }),
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
  'v1.TodoTextChanged': ({ id, text }) => todosTable.update({ text }).where({ id }),
  'v1.TodoCompletionChanged': ({ id, completed }) => todosTable.update({ completed }).where({ id }),
  'v1.TodoDeleted': ({ id }) => todosTable.delete().where({ id }),
})

export const todoSchema = makeSchema({
  events: todoEvents,
  state: State.SQLite.makeState({
    tables: { todos: todosTable },
    materializers,
  }),
})

const CreateTodoInput = Schema.Struct({ id: Schema.String, text: Schema.String })
const EditTodoInput = Schema.Struct({ id: Schema.String, text: Schema.String })
const SetTodoCompletedInput = Schema.Struct({ id: Schema.String, completed: Schema.Boolean })
const DeleteTodoInput = Schema.Struct({ id: Schema.String })
const TodoRows = Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String, completed: Schema.Boolean }))

export const todoApplication = defineApplication({
  id: 'scenario-todo-app',
  scenarioName: 'todo',
  schema: todoSchema,
  actions: {
    createTodo: defineAction<typeof todoSchema, typeof CreateTodoInput>({
      input: CreateTodoInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(todoEvents.created(input))),
    }),
    editTodo: defineAction<typeof todoSchema, typeof EditTodoInput>({
      input: EditTodoInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(todoEvents.textChanged(input))),
    }),
    setTodoCompleted: defineAction<typeof todoSchema, typeof SetTodoCompletedInput>({
      input: SetTodoCompletedInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(todoEvents.completionChanged(input))),
    }),
    deleteTodo: defineAction<typeof todoSchema, typeof DeleteTodoInput>({
      input: DeleteTodoInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(todoEvents.deleted(input))),
    }),
  },
  inspectors: {
    todos: defineInspector<typeof todoSchema, typeof TodoRows>({
      output: TodoRows,
      read: ({ store }) => store.query(todosTable).toSorted((left, right) => left.id.localeCompare(right.id)),
    }),
  },
})

/** Typed Scenario-as-code action vocabulary for the Todo Application. */
export const todo = scenarioApplication(todoApplication)
