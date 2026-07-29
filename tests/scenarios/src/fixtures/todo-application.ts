import { Events, makeSchema, State } from '@livestore/common/schema'
import { Effect, Schema } from '@livestore/utils/effect'

import { defineAction, defineApplication, defineInspector, defineWorkload } from '../application.ts'

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
  roomAvailabilityInitialized: Events.synced({
    name: 'v1.RoomAvailabilityInitialized',
    schema: Schema.Struct({ roomId: Schema.String, available: Schema.Int }),
  }),
  availableRoomDecremented: Events.synced({
    name: 'v1.AvailableRoomDecremented',
    schema: Schema.Struct({ roomId: Schema.String }),
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

export const roomAvailabilityTable = State.SQLite.table({
  name: 'room_availability',
  columns: {
    roomId: State.SQLite.text({ primaryKey: true }),
    available: State.SQLite.integer({ nullable: false }),
  },
})

/**
 * State.SQLite does not yet expose CHECK constraints in its table DSL. The
 * fixture installs the equivalent SQLite guard so the red-team Scenario still
 * exercises a database-enforced invariant rather than application validation.
 */
const installRoomAvailabilityGuard = `
  CREATE TRIGGER IF NOT EXISTS room_availability_nonnegative
  BEFORE UPDATE OF available ON room_availability
  FOR EACH ROW WHEN NEW.available < 0
  BEGIN
    SELECT RAISE(ABORT, 'CHECK constraint failed: room_availability.available_nonnegative');
  END
`

const materializers = State.SQLite.materializers(todoEvents, {
  'v1.TodoCreated': ({ id, text }) => todosTable.insert({ id, text, completed: false }),
  'v1.TodoTextChanged': ({ id, text }) => todosTable.update({ text }).where({ id }),
  'v1.TodoCompletionChanged': ({ id, completed }) => todosTable.update({ completed }).where({ id }),
  'v1.TodoDeleted': ({ id }) => todosTable.delete().where({ id }),
  'v1.RoomAvailabilityInitialized': ({ roomId, available }) => [
    roomAvailabilityTable.insert({ roomId, available }),
    installRoomAvailabilityGuard,
  ],
  'v1.AvailableRoomDecremented': ({ roomId }) => ({
    sql: 'UPDATE room_availability SET available = available - 1 WHERE roomId = $roomId',
    bindValues: { roomId },
    writeTables: new Set([roomAvailabilityTable.sqliteDef.name]),
  }),
})

export const todoSchema = makeSchema({
  events: todoEvents,
  state: State.SQLite.makeState({
    tables: { todos: todosTable, roomAvailability: roomAvailabilityTable },
    materializers,
  }),
})

const CreateTodoInput = Schema.Struct({ id: Schema.String, text: Schema.String })
const EditTodoInput = Schema.Struct({ id: Schema.String, text: Schema.String })
const SetTodoCompletedInput = Schema.Struct({ id: Schema.String, completed: Schema.Boolean })
const DeleteTodoInput = Schema.Struct({ id: Schema.String })
const CreateTodoBurstInput = Schema.Struct({ idPrefix: Schema.String, textPrefix: Schema.String })
const TodoRows = Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String, completed: Schema.Boolean }))
const InitializeRoomAvailabilityInput = Schema.Struct({ roomId: Schema.String, available: Schema.Int })
const DecrementAvailableRoomInput = Schema.Struct({ roomId: Schema.String })
const RoomAvailabilityRows = Schema.Array(Schema.Struct({ roomId: Schema.String, available: Schema.Int }))

export const todoApplication = defineApplication({
  id: 'scenario-todo-app',
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
    initializeRoomAvailability: defineAction<typeof todoSchema, typeof InitializeRoomAvailabilityInput>({
      input: InitializeRoomAvailabilityInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(todoEvents.roomAvailabilityInitialized(input))),
    }),
    decrementAvailableRoom: defineAction<typeof todoSchema, typeof DecrementAvailableRoomInput>({
      input: DecrementAvailableRoomInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(todoEvents.availableRoomDecremented(input))),
    }),
  },
  workloads: {
    createTodoBurst: defineWorkload({
      input: CreateTodoBurstInput,
      generate: ({ input, targets, iteration, random }) => ({
        target: random.pick(targets),
        action: 'createTodo',
        input: {
          id: `${input.idPrefix}-${String(iteration + 1).padStart(3, '0')}`,
          text: `${input.textPrefix} ${iteration + 1} · variant ${random.integer(1_000)}`,
        },
      }),
    }),
  },
  inspectors: {
    todos: defineInspector<typeof todoSchema, typeof TodoRows>({
      output: TodoRows,
      read: ({ store }) => store.query(todosTable).toSorted((left, right) => left.id.localeCompare(right.id)),
    }),
    roomAvailability: defineInspector<typeof todoSchema, typeof RoomAvailabilityRows>({
      output: RoomAvailabilityRows,
      read: ({ store }) =>
        store.query(roomAvailabilityTable).toSorted((left, right) => left.roomId.localeCompare(right.roomId)),
    }),
  },
})
