//! Port of `examples/web-todomvc-sync-cf/src/livestore/schema.ts` on the schema DSL.

#![warn(clippy::unwrap_used)]

use std::sync::{Arc, LazyLock};

use livestore_schema::query_builder::{Filter, QueryBuilderError, SqlQuery};
use livestore_schema::value_schema::{self as s, Val, ValueSchema};
use livestore_schema::{
    ClientDocument, Column, EventDef, MaterializeError, Schema, SqlStatement, Table,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TodoCreated {
    pub id: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TodoId {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TodoDeleted {
    pub id: String,
    /// `Schema.DateFromString` encoded form.
    pub deleted_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TodoClearedCompleted {
    pub deleted_at: String,
}

pub mod events {
    use super::{
        EventDef, LazyLock, TodoClearedCompleted, TodoCreated, TodoDeleted, TodoId, ValueSchema, s,
    };

    pub static TODO_CREATED: LazyLock<EventDef<TodoCreated>> = LazyLock::new(|| {
        EventDef::synced("v1.TodoCreated")
            .schema(s::struct_([("id", s::string()), ("text", s::string())]))
    });
    pub static TODO_COMPLETED: LazyLock<EventDef<TodoId>> =
        LazyLock::new(|| EventDef::synced("v1.TodoCompleted").schema(todo_id()));
    pub static TODO_UNCOMPLETED: LazyLock<EventDef<TodoId>> =
        LazyLock::new(|| EventDef::synced("v1.TodoUncompleted").schema(todo_id()));
    pub static TODO_DELETED: LazyLock<EventDef<TodoDeleted>> = LazyLock::new(|| {
        EventDef::synced("v1.TodoDeleted").schema(s::struct_([
            ("id", s::string()),
            ("deletedAt", s::date_from_string()),
        ]))
    });
    pub static TODO_CLEARED_COMPLETED: LazyLock<EventDef<TodoClearedCompleted>> =
        LazyLock::new(|| {
            EventDef::synced("v1.TodoClearedCompleted")
                .schema(s::struct_([("deletedAt", s::date_from_string())]))
        });

    fn todo_id() -> ValueSchema {
        s::struct_([("id", s::string())])
    }
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
        .event(&events::TODO_CREATED, move |a, _| {
            sql(todos
                .query()
                .insert([
                    ("id", json!(a.id)),
                    ("text", json!(a.text)),
                    ("completed", json!(false)),
                ])
                .as_sql())
        })
        .event(&events::TODO_COMPLETED, move |a, _| {
            sql(todos
                .query()
                .update([("completed", json!(true))])
                .where_all([("id", json!(a.id).into())])
                .as_sql())
        })
        .event(&events::TODO_UNCOMPLETED, move |a, _| {
            sql(todos
                .query()
                .update([("completed", json!(false))])
                .where_all([("id", json!(a.id).into())])
                .as_sql())
        })
        .event(&events::TODO_DELETED, move |a, _| {
            sql(todos
                .query()
                .update([("deletedAt", json!(a.deleted_at))])
                .where_all([("id", json!(a.id).into())])
                .as_sql())
        })
        .event(&events::TODO_CLEARED_COMPLETED, move |a, _| {
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
