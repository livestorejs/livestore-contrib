//! Port of `examples/web-todomvc-sync-cf/src/livestore/schema.ts` on the schema DSL.

#![warn(clippy::unwrap_used)]

use std::sync::{Arc, LazyLock};

use livestore_schema::event_def::DateFromString;
use livestore_schema::query_builder::{Filter, QueryBuilderError, SqlQuery};
use livestore_schema::value_schema::{self as s, Val};
use livestore_schema::{
    ClientDocument, Column, Event, MaterializeError, Schema, SqlStatement, Table,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// `v1.TodoCreated`.
#[derive(Event, Serialize, Deserialize, Clone, Debug)]
#[event(name = "v1.TodoCreated")]
pub struct TodoCreated {
    pub id: String,
    pub text: String,
}

/// `v1.TodoCompleted`.
#[derive(Event, Serialize, Deserialize, Clone, Debug)]
#[event(name = "v1.TodoCompleted")]
pub struct TodoCompleted {
    pub id: String,
}

/// `v1.TodoUncompleted`.
#[derive(Event, Serialize, Deserialize, Clone, Debug)]
#[event(name = "v1.TodoUncompleted")]
pub struct TodoUncompleted {
    pub id: String,
}

/// `v1.TodoDeleted`.
#[derive(Event, Serialize, Deserialize, Clone, Debug)]
#[event(name = "v1.TodoDeleted")]
#[serde(rename_all = "camelCase")]
pub struct TodoDeleted {
    pub id: String,
    pub deleted_at: DateFromString,
}

/// `v1.TodoClearedCompleted`.
#[derive(Event, Serialize, Deserialize, Clone, Debug)]
#[event(name = "v1.TodoClearedCompleted")]
#[serde(rename_all = "camelCase")]
pub struct TodoClearedCompleted {
    pub deleted_at: DateFromString,
}

pub static TODOS: LazyLock<Table> = LazyLock::new(|| {
    Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""))
        .column(Column::boolean("completed").default(false))
        .column(Column::datetime_millis("deletedAt").nullable())
});

#[must_use]
pub fn ui_state() -> ClientDocument {
    let value = s::struct_([
        ("newTodoText", s::string()),
        ("filter", s::literals(["all", "active", "completed"])),
    ]);
    ClientDocument::new(
        "uiState",
        value,
        Val::from(json!({"newTodoText": "", "filter": "all"})),
    )
}

#[must_use]
pub fn schema() -> Arc<Schema> {
    let todos = &*TODOS;
    Schema::builder()
        .table(todos.clone())
        .client_document(ui_state())
        .materialize::<TodoCreated, _>(move |a, _| {
            sql(todos
                .query()
                .insert([
                    ("id", json!(a.id)),
                    ("text", json!(a.text)),
                    ("completed", json!(false)),
                ])
                .as_sql())
        })
        .materialize::<TodoCompleted, _>(move |a, _| {
            sql(todos
                .query()
                .update([("completed", json!(true))])
                .where_all([("id", json!(a.id).into())])
                .as_sql())
        })
        .materialize::<TodoUncompleted, _>(move |a, _| {
            sql(todos
                .query()
                .update([("completed", json!(false))])
                .where_all([("id", json!(a.id).into())])
                .as_sql())
        })
        .materialize::<TodoDeleted, _>(move |a, _| {
            sql(todos
                .query()
                .update([("deletedAt", json!(a.deleted_at))])
                .where_all([("id", json!(a.id).into())])
                .as_sql())
        })
        .materialize::<TodoClearedCompleted, _>(move |a, _| {
            sql(todos
                .query()
                .update([("deletedAt", json!(a.deleted_at))])
                .where_all([("completed", json!(true).into())])
                .as_sql())
        })
        .build()
}

fn sql(query: Result<SqlQuery, QueryBuilderError>) -> Result<SqlStatement, MaterializeError> {
    query
        .map(SqlStatement::from)
        .map_err(|e| MaterializeError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn ddl_matches_ts() {
        let ddl: Vec<String> = super::schema()
            .tables()
            .iter()
            .flat_map(livestore_schema::Table::ddl)
            .collect();
        assert_eq!(
            ddl,
            [
                r#"create table if not exists "todos" ("id" text primary key   , "text" text   not null default '', "completed" integer   not null default 0, "deletedAt" integer    ) strict"#,
                r#"create table if not exists "uiState" ("id" text primary key   , "value" text   not null ) strict"#,
            ]
        );
    }
}
