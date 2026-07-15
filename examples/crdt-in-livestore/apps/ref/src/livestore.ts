import { Events, makeSchema, Schema, State } from '@livestore/livestore'

export const documentId = 'reference-only-document'

export const documentRefs = State.SQLite.table({
  name: 'document_refs',
  columns: {
    doc_id: State.SQLite.text({ primaryKey: true }),
    loro_channel: State.SQLite.text(),
  },
})

export const events = {
  documentReferenced: Events.synced({
    name: 'DocumentReferenced',
    schema: Schema.Struct({
      docId: Schema.String,
      loroChannel: Schema.String,
    }),
  }),
}

const materializers = State.SQLite.materializers(events, {
  DocumentReferenced: ({ docId, loroChannel }) => ({
    sql: 'INSERT OR REPLACE INTO document_refs (doc_id, loro_channel) VALUES (?, ?)',
    // LiveStore accepts positional binds at runtime; its public materializer type currently only names object binds.
    bindValues: [docId, loroChannel] as any,
  }),
})

const state = State.SQLite.makeState({ tables: { documentRefs }, materializers })

export const schema = makeSchema({ events, state })

export type RefRow = {
  readonly doc_id: string
  readonly loro_channel: string
}

export const refsForDocument = documentRefs.select().where({ doc_id: documentId }).orderBy('doc_id', 'asc')
