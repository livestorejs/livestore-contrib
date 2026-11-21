//! Test fixtures: `packages/@livestore/livestore/src/utils/tests/fixture.ts` (todomvc) and
//! `tests/package-common/src/leader-thread/fixture.ts` (session fixture with a non-pure materializer).
#![allow(dead_code)]

pub mod harness;
pub mod otel;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock};

use livestore::{EventInput, Store, StoreOptions, create_store, make_in_memory_adapter};
use livestore_core::SeqNum;
use livestore_schema::codec::iso_string_from_millis;
use livestore_schema::value_schema as s;
use livestore_schema::{ClientDocument, Column, EventDef, Schema, SqlValue, Table, Val};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub fn ev(name: &str, args: Value) -> EventInput {
    EventInput {
        name: name.into(),
        args,
    }
}

/// The todomvc fixture of the livestore package tests.
pub mod todomvc {
    use livestore_schema::query_builder::{Filter, QueryBuilderError, SqlQuery};
    use livestore_schema::{MaterializeError, SqlStatement};

    use super::*;

    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    pub struct TodoCreated {
        pub id: String,
        pub text: String,
        pub completed: bool,
    }

    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    pub struct TodoId {
        pub id: String,
    }

    pub static TODO_CREATED: LazyLock<EventDef<TodoCreated>> =
        LazyLock::new(|| EventDef::synced("todo.created"));
    pub static TODO_COMPLETED: LazyLock<EventDef<TodoId>> =
        LazyLock::new(|| EventDef::synced("todo.completed"));

    pub static TODOS: LazyLock<Table> = LazyLock::new(|| {
        Table::new("todos")
            .column(Column::text("id").primary_key())
            .column(Column::text("text").default(""))
            .column(Column::boolean("completed").default(false))
    });

    pub fn app() -> ClientDocument {
        let value = s::struct_([("newTodoText", s::string()), ("filter", s::string())]);
        ClientDocument::new(
            "app",
            value,
            Val::from(json!({ "newTodoText": "", "filter": "all" })),
        )
    }

    pub fn todo_created(id: &str, text: &str, completed: bool) -> EventInput {
        TODO_CREATED
            .make(TodoCreated {
                id: id.into(),
                text: text.into(),
                completed,
            })
            .into()
    }

    pub fn todo_completed(id: &str) -> EventInput {
        TODO_COMPLETED.make(TodoId { id: id.into() }).into()
    }

    pub fn schema() -> Arc<Schema> {
        let (t1, t2) = (TODOS.clone(), TODOS.clone());
        Schema::builder()
            .table(TODOS.clone())
            .client_document(app())
            .event(&TODO_CREATED, move |a, _| {
                sql(t1
                    .query()
                    .insert([
                        ("id", json!(a.id)),
                        ("text", json!(a.text)),
                        ("completed", json!(a.completed)),
                    ])
                    .as_sql())
            })
            .event(&TODO_COMPLETED, move |a, _| {
                sql(t2
                    .query()
                    .update([("completed", json!(true))])
                    .where_eq("id", json!(a.id))
                    .as_sql())
            })
            .build()
    }

    fn sql(query: Result<SqlQuery, QueryBuilderError>) -> Result<SqlStatement, MaterializeError> {
        query
            .map(SqlStatement::from)
            .map_err(|e| MaterializeError::Other(e.to_string()))
    }

    /// `makeTodoMvc()`.
    pub async fn make_todo_mvc() -> Store {
        let mut options = StoreOptions::new(schema(), make_in_memory_adapter(), "default");
        options.debug_instance_id = Some("test".into());
        create_store(options).await.expect("store boots")
    }

    pub fn todo(id: &str, text: &str, completed: bool) -> Value {
        json!({ "id": id, "text": text, "completed": completed })
    }
}

/// The session fixture of `tests/package-common` (`leader-thread/fixture.ts`).
pub mod session {
    use super::*;

    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    pub struct TodoCreated {
        pub id: String,
        pub text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub completed: Option<bool>,
    }

    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    pub struct TodoId {
        pub id: String,
    }

    pub static TODO_CREATED: LazyLock<EventDef<TodoCreated>> =
        LazyLock::new(|| EventDef::synced("todoCreated"));
    pub static TODO_COMPLETED: LazyLock<EventDef<TodoId>> =
        LazyLock::new(|| EventDef::synced("todoCompleted"));
    pub static TODO_DELETED_NON_PURE: LazyLock<EventDef<TodoId>> =
        LazyLock::new(|| EventDef::synced("todoDeletedNonPure"));

    pub static TODOS: LazyLock<Table> = LazyLock::new(|| {
        Table::new("todos")
            .column(Column::text("id").primary_key())
            .column(Column::text("text").default(""))
            .column(Column::boolean("completed").default(false))
            .column(Column::datetime("deletedAt").nullable())
    });

    pub fn app_config() -> ClientDocument {
        let value = s::struct_([
            ("fontSize", s::finite()),
            ("theme", s::literals(["light", "dark"])),
        ]);
        ClientDocument::new(
            "app_config",
            value,
            Val::from(json!({ "fontSize": 16, "theme": "light" })),
        )
    }

    /// Advanced on every read, like a clock, so leader and session never compute the same non-pure result.
    static NON_PURE_CLOCK: AtomicI64 = AtomicI64::new(0);

    pub fn schema() -> Arc<Schema> {
        let (t1, t2, t3) = (TODOS.clone(), TODOS.clone(), TODOS.clone());
        Schema::builder()
            .table(TODOS.clone())
            .client_document(app_config())
            .event(&TODO_CREATED, move |a, _| {
                Ok(t1.insert([
                    ("id", a.id.into()),
                    ("text", a.text.into()),
                    ("completed", a.completed.unwrap_or(false).into()),
                ]))
            })
            .event(&TODO_COMPLETED, move |a, _| {
                Ok(t2
                    .update([("completed", true.into())])
                    .where_eq([("id", a.id.into())]))
            })
            .event(&TODO_DELETED_NON_PURE, move |a, _| {
                let at = iso_string_from_millis(NON_PURE_CLOCK.fetch_add(1, Ordering::SeqCst) + 1);
                Ok(t3
                    .update([("deletedAt", SqlValue::Text(at))])
                    .where_eq([("id", a.id.into())]))
            })
            .build()
    }

    pub fn todo_created(id: &str, text: &str) -> EventInput {
        TODO_CREATED
            .make(TodoCreated {
                id: id.into(),
                text: text.into(),
                completed: Some(false),
            })
            .into()
    }

    pub fn todo_created_args(id: &str, text: &str) -> Value {
        json!({ "id": id, "text": text, "completed": false })
    }

    /// `LiveStoreEvent.Client.Encoded.make({...})` for a remote event.
    pub fn encoded(
        name: &str,
        args: Value,
        seq: SeqNum,
        parent: SeqNum,
        client: &str,
        session: &str,
    ) -> livestore_core::Event {
        livestore_core::Event {
            name: name.into(),
            args,
            seq_num: seq,
            parent_seq_num: parent,
            client_id: client.into(),
            session_id: session.into(),
        }
    }
}

/// Reads the persisted state head (`getStateHead`).
pub fn state_head(store: &Store) -> SeqNum {
    store
        .sqlite_db_wrapper()
        .with_conn(livestore_sqlite::state::head)
        .expect("state head")
}

pub fn journal_count(store: &Store) -> i64 {
    store.sqlite_db_wrapper().with_conn(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM __livestore_materialization_journal",
            [],
            |r| r.get(0),
        )
        .expect("journal count")
    })
}

pub fn ids(rows: &Value) -> Vec<String> {
    rows.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| r["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub fn len(rows: &Value) -> usize {
    rows.as_array().map_or(0, Vec::len)
}

/// Test counts and indices as the `i64` sequence numbers they become.
pub fn to_i64(n: usize) -> i64 {
    i64::try_from(n).expect("test counts fit in i64")
}
