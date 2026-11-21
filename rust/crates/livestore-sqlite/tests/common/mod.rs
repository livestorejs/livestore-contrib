#![allow(dead_code)]

use std::sync::Arc;

use livestore_core::{Event, SeqNum};
use livestore_schema::{ClientDocument, Column, EventDef, Schema, Table};
use livestore_sqlite::{LeaderDb, Row, state};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Serialize, Deserialize)]
pub struct TodoCreated {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<bool>,
}

#[derive(Serialize, Deserialize)]
pub struct TodoId {
    pub id: String,
}

pub fn todos() -> Table {
    Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""))
        .column(Column::boolean("completed").default(false))
        .column(
            Column::datetime("deletedAt")
                .nullable()
                .default(livestore_schema::Val::Null),
        )
}

/// `tests/package-common/src/leader-thread/fixture.ts` schema.
pub fn schema() -> Arc<Schema> {
    let (t1, t2) = (todos(), todos());
    Schema::builder()
        .table(todos())
        .client_document(ClientDocument::new(
            "app_config",
            livestore_schema::value_schema::struct_([
                ("fontSize", livestore_schema::value_schema::finite()),
                ("theme", livestore_schema::value_schema::string()),
            ]),
            json!({"fontSize": 16, "theme": "light"}),
        ))
        .event(
            &EventDef::<TodoCreated>::synced("todoCreated"),
            move |a, _| {
                Ok(t1.insert([
                    ("id", a.id.into()),
                    ("text", a.text.into()),
                    ("completed", a.completed.unwrap_or(false).into()),
                ]))
            },
        )
        .event(&EventDef::<TodoId>::synced("todoCompleted"), move |a, _| {
            Ok(t2
                .update([("completed", true.into())])
                .where_eq([("id", a.id.into())]))
        })
        .build()
}

/// `migrateDb` on a fresh in-memory state DB.
pub fn migrated_state(schema: &Schema) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    state::migrate(&conn, schema).unwrap();
    conn
}

/// `initEventlogDb` + `recreateDb` over two in-memory DBs.
pub fn leader_db(schema: Arc<Schema>) -> LeaderDb {
    LeaderDb::open_in_memory(schema).unwrap()
}

/// `getJournalChangeset`: `None` without a row, `Some(None)` for a recorded no-op.
#[expect(
    clippy::option_option,
    reason = "distinguishes a missing journal row from a recorded no-op"
)]
pub fn journal_changeset(conn: &Connection, key: SeqNum) -> Option<Option<Vec<u8>>> {
    conn.query_row(
        "SELECT changeset FROM __livestore_materialization_journal WHERE seqNumGlobal = ? AND seqNumClient = ? AND seqNumRebaseGeneration = ? LIMIT 1",
        params![key.global, key.client, key.rebase_generation],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
}

pub fn select(conn: &Connection, sql: &str) -> Vec<Row> {
    livestore_sqlite::db::query_rows(conn, sql).unwrap()
}

pub fn event(
    name: &str,
    args: serde_json::Value,
    seq_num: SeqNum,
    parent_seq_num: SeqNum,
    client_id: &str,
    session_id: &str,
) -> Event {
    Event {
        name: name.into(),
        args,
        seq_num,
        parent_seq_num,
        client_id: client_id.into(),
        session_id: session_id.into(),
    }
}
