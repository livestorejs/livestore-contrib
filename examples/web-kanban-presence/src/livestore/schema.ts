import { Events, makeSchema, Schema, State } from '@livestore/livestore'

// Durable, synced state for the kanban board — persisted in SQLite via the
// eventlog + sync backend. This is the "storage" half of the partykit model.
export const tables = {
  columns: State.SQLite.table({
    name: 'columns',
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      title: State.SQLite.text({ default: '' }),
      position: State.SQLite.integer({ default: 0 }),
    },
  }),
  cards: State.SQLite.table({
    name: 'cards',
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      title: State.SQLite.text({ default: '' }),
      columnId: State.SQLite.text({ default: '' }),
      position: State.SQLite.integer({ default: 0 }),
    },
  }),
}

export const events = {
  columnCreated: Events.synced({
    name: 'v1.KanbanColumnCreated',
    schema: Schema.Struct({ id: Schema.String, title: Schema.String, position: Schema.Finite }),
  }),
  columnRenamed: Events.synced({
    name: 'v1.KanbanColumnRenamed',
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
  }),
  cardCreated: Events.synced({
    name: 'v1.KanbanCardCreated',
    schema: Schema.Struct({ id: Schema.String, title: Schema.String, columnId: Schema.String, position: Schema.Finite }),
  }),
  cardMoved: Events.synced({
    name: 'v1.KanbanCardMoved',
    schema: Schema.Struct({ id: Schema.String, columnId: Schema.String, position: Schema.Finite }),
  }),
  cardRenamed: Events.synced({
    name: 'v1.KanbanCardRenamed',
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
  }),
}

const materializers = State.SQLite.materializers(events, {
  'v1.KanbanColumnCreated': ({ id, title, position }) => tables.columns.insert({ id, title, position }),
  'v1.KanbanColumnRenamed': ({ id, title }) => tables.columns.update({ title }).where({ id }),
  'v1.KanbanCardCreated': ({ id, title, columnId, position }) => tables.cards.insert({ id, title, columnId, position }),
  'v1.KanbanCardMoved': ({ id, columnId, position }) => tables.cards.update({ columnId, position }).where({ id }),
  'v1.KanbanCardRenamed': ({ id, title }) => tables.cards.update({ title }).where({ id }),
})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })

export const SyncPayload = Schema.Struct({ authToken: Schema.String })