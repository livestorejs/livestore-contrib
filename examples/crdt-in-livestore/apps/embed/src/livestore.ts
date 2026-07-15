import { Events, makeSchema, Schema, State } from "@livestore/livestore";

export const crdtUpdates = State.SQLite.table({
  name: "crdt_updates",
  columns: {
    doc_id: State.SQLite.text({ primaryKey: true }),
    update_id: State.SQLite.text({ primaryKey: true }),
    update_bytes_base64: State.SQLite.text(),
    origin_replica: State.SQLite.text(),
    origin_sequence: State.SQLite.integer(),
    created_at: State.SQLite.integer(),
  },
});

export const events = {
  loroUpdate: Events.synced({
    name: "LoroUpdate",
    schema: Schema.Struct({
      docId: Schema.String,
      updateId: Schema.String,
      updateBase64: Schema.String,
      originReplica: Schema.String,
      originSequence: Schema.Number,
      createdAt: Schema.Number,
    }),
  }),
};

const materializers = State.SQLite.materializers(events, {
  LoroUpdate: ({ docId, updateId, updateBase64, originReplica, originSequence, createdAt }) => ({
    sql: "INSERT OR IGNORE INTO crdt_updates (doc_id, update_id, update_bytes_base64, origin_replica, origin_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    // LiveStore accepts positional binds at runtime; its public materializer type currently only names object binds.
    bindValues: [docId, updateId, updateBase64, originReplica, originSequence, createdAt] as any,
  }),
});

const state = State.SQLite.makeState({ tables: { crdtUpdates }, materializers });

export const schema = makeSchema({ events, state });

export type UpdateRow = {
  readonly doc_id: string;
  readonly update_id: string;
  readonly update_bytes_base64: string;
  readonly origin_replica: string;
  readonly origin_sequence: number;
  readonly created_at: number;
};

export const updatesForDocument = (documentId: string) =>
  crdtUpdates.select().where({ doc_id: documentId }).orderBy("created_at", "asc").orderBy("update_id", "asc");
