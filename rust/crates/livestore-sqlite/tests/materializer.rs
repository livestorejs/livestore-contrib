mod common;

use std::sync::Arc;

use livestore_schema::value_schema as s;
use livestore_schema::{Column, EventDef, MaterializeError, Schema, SqlStatement, Table};
use livestore_sqlite::LocalLeader;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[test]
fn should_allow_queries_in_materializer() {
    for event in ["todoCreated", "todoCreatedRaw"] {
        let mut store = LocalLeader::open_in_memory(schema(), "client", "session").unwrap();
        for id in ["a", "b", "c"] {
            store.commit(event, json!({"id": id, "text": id})).unwrap();
        }
        assert_eq!(
            query_table(&store, &todos()),
            json!([
                {"completed": false, "id": "a", "text": "a", "previousIds": []},
                {"completed": false, "id": "b", "text": "b", "previousIds": ["a"]},
                {"completed": false, "id": "c", "text": "c", "previousIds": ["a", "b"]},
            ]),
            "{event}"
        );
    }
}

#[test]
fn should_allow_empty_event_payload() {
    let mut store = LocalLeader::open_in_memory(schema(), "client", "session").unwrap();
    store.commit("emptyEventPayload", Value::Null).unwrap();
}

#[test]
fn should_pass_full_event_with_client_id_to_materializer() {
    let messages = Table::new("messages")
        .column(Column::text("id").primary_key())
        .column(Column::text("content"))
        .column(Column::text("createdBy"));
    let m = messages.clone();
    let schema = Schema::builder()
        .table(messages.clone())
        .event(
            &EventDef::<MessageCreated>::synced("messageCreated"),
            move |a, ctx| {
                Ok(m.insert([
                    ("id", a.id.into()),
                    ("content", a.content.into()),
                    ("createdBy", ctx.event.client_id.clone().into()),
                ]))
            },
        )
        .build();
    let mut store = LocalLeader::open_in_memory(schema, "test-client-123", "session").unwrap();

    store
        .commit(
            "messageCreated",
            json!({"id": "msg1", "content": "Hello world"}),
        )
        .unwrap();

    let rows = query_table(&store, &messages);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(
        rows[0],
        json!({"id": "msg1", "content": "Hello world", "createdBy": "test-client-123"})
    );
}

#[derive(Serialize, Deserialize)]
struct TodoCreated {
    id: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct MessageCreated {
    id: String,
    content: String,
}

fn todos() -> Table {
    Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""))
        .column(Column::boolean("completed").default(false))
        .column(Column::json("previousIds").schema(s::array(s::string())))
}

fn schema() -> Arc<Schema> {
    let (t1, t2) = (todos(), todos());
    Schema::builder()
        .table(todos())
        .event(
            &EventDef::<TodoCreated>::synced("todoCreated"),
            move |a, ctx| {
                let select = t1.query().select(&["id"]);
                let sql = select.as_sql().map_err(other)?;
                let rows = ctx.query(&sql.query, &sql.bind_values)?;
                let previous_ids = select.decode_result(&Value::Array(rows)).map_err(other)?;
                Ok(insert(&t1, a, &previous_ids))
            },
        )
        .event(
            &EventDef::<TodoCreated>::synced("todoCreatedRaw"),
            move |a, ctx| {
                let rows = ctx.query("SELECT id FROM todos", &[])?;
                let previous_ids = rows.into_iter().map(|r| r["id"].clone()).collect();
                Ok(insert(&t2, a, &previous_ids))
            },
        )
        .event(&EventDef::<()>::synced("emptyEventPayload"), |(), _| {
            Ok(Vec::<SqlStatement>::new())
        })
        .build()
}

fn insert(table: &Table, a: TodoCreated, previous_ids: &Value) -> SqlStatement {
    table.insert([
        ("id", a.id.into()),
        ("text", a.text.into()),
        ("completed", a.completed.unwrap_or(false).into()),
        ("previousIds", previous_ids.to_string().into()),
    ])
}

fn query_table(store: &LocalLeader, table: &Table) -> Value {
    let select = table.query();
    let sql = select.as_sql().unwrap();
    let rows = livestore_sqlite::db::query_rows_with(
        store.db().state_conn(),
        &sql.query,
        &sql.bind_values,
    )
    .unwrap();
    select
        .decode_result(&Value::Array(rows.into_iter().map(Value::Object).collect()))
        .unwrap()
}

fn other(e: impl std::fmt::Display) -> MaterializeError {
    MaterializeError::Other(e.to_string())
}
