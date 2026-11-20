//! Mirrors `tests/package-common/src/leader-thread/fixture.ts`.
#![allow(dead_code)]

use std::sync::Arc;

use livestore_core::{Event, GlobalEvent};
use livestore_schema::{ClientDocument, Column, EventDef, Schema, Table};
use livestore_sync::testing::{ClientIdentity, EventFactory};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Serialize, Deserialize)]
struct TodoCreated {
    id: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct TodoId {
    id: String,
}

pub fn fixture_schema() -> Arc<Schema> {
    let todos = Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""))
        .column(Column::boolean("completed").default(false))
        .column(
            Column::datetime("deletedAt")
                .nullable()
                .default(livestore_schema::Val::Null),
        );
    let (t1, t2) = (todos.clone(), todos.clone());
    Schema::builder()
        .table(todos)
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

pub trait TodoFactory {
    fn todo_global(&mut self, id: &str, text: &str) -> GlobalEvent;
    fn todo(&mut self, id: &str, text: &str) -> Event {
        self.todo_global(id, text).into()
    }
}

impl TodoFactory for EventFactory {
    fn todo_global(&mut self, id: &str, text: &str) -> GlobalEvent {
        self.next(
            "todoCreated",
            json!({"id": id, "text": text, "completed": false}),
        )
    }
}

pub fn factory(client: &str, session: &str) -> EventFactory {
    EventFactory::new(ClientIdentity::with_session(client, session))
}

pub fn backend_factory() -> EventFactory {
    factory("mock-backend", "static-session-id")
}
