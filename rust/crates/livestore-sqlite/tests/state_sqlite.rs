mod common;

use livestore_schema::{Column, Table, Val};
use rusqlite::Connection;
use serde_json::{Value, json};

#[test]
fn should_work_for_nullable_json_fields_with_default_null() {
    let table = test_table(Val::Null);
    let db = setup(&table);
    db.execute_batch("insert into test (id) values (1)")
        .unwrap();

    let raw = raw_rows(&db);
    assert_eq!(raw, vec![json!({"id": 1, "json": null})]);
    assert_eq!(decode_first(&table, &raw), json!({"id": 1, "json": null}));
}

#[test]
fn should_work_for_nullable_json_fields_with_default_null_as_a_string() {
    let table = test_table(Val::from("null"));
    let db = setup(&table);
    db.execute_batch("insert into test (id) values (1)")
        .unwrap();

    let raw = raw_rows(&db);
    assert_eq!(raw, vec![json!({"id": 1, "json": "\"null\""})]);
    assert_eq!(decode_first(&table, &raw), json!({"id": 1, "json": "null"}));
}

fn test_table(default: Val) -> Table {
    Table::new("test")
        .column(Column::integer("id").primary_key())
        .column(Column::json("json").default(default).nullable())
}

/// `migrateTable({ behaviour: 'drop-and-recreate', skipMetaTable: true })`.
fn setup(table: &Table) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(&format!("drop table if exists '{}'", table.name))
        .unwrap();
    for sql in table.ddl() {
        db.execute_batch(&sql).unwrap();
    }
    db
}

fn raw_rows(db: &Connection) -> Vec<Value> {
    common::select(db, "select * from test")
        .into_iter()
        .map(Value::Object)
        .collect()
}

fn decode_first(table: &Table, rows: &[Value]) -> Value {
    table
        .row_schema()
        .decode(Val::from(rows[0].clone()))
        .unwrap()
        .to_json_value()
}
