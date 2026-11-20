use livestore_schema::{Column, Schema, Table};
use livestore_sqlite::{BootOptions, LeaderDb, state};
use rusqlite::Connection;
use serde_json::{Value, json};

#[test]
fn preserves_imported_snapshots_without_a_rebuild_completion_marker_1605() {
    let todos = Table::new("todos").column(Column::text("id").primary_key());
    let schema = Schema::builder().table(todos).build();
    let source = Connection::open_in_memory().unwrap();
    state::migrate(&source, &schema).unwrap();
    source
        .execute_batch("INSERT INTO todos (id) VALUES ('imported'); DROP TABLE __livestore_rebuild")
        .unwrap();
    let snapshot = source.serialize("main").unwrap().to_vec();

    let db = LeaderDb::boot_with(
        Connection::open_in_memory().unwrap(),
        Connection::open_in_memory().unwrap(),
        schema,
        BootOptions {
            import_snapshot: Some(snapshot),
            ..Default::default()
        },
    )
    .unwrap();

    let rows: Vec<Value> = db
        .query("SELECT * FROM todos")
        .unwrap()
        .into_iter()
        .map(Value::Object)
        .collect();
    assert_eq!(rows, vec![json!({"id": "imported"})]);
}
