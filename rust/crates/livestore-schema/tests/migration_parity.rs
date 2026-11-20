//! Port of `schema-management/__tests__/migrations-autoincrement-quoting.test.ts`.

use livestore_schema::fingerprint::table_fingerprint;
use livestore_schema::migration::{MigrateBehaviour, migrate_table};
use livestore_schema::system_tables::{SCHEMA_META_TABLE, state_tables};
use livestore_schema::{Column, ColumnType, SqlValue, Table};

#[test]
fn creates_valid_create_table_with_inline_integer_primary_key_autoincrement_and_double_quoted_identifiers()
 {
    let table = Table::new("todos")
        .column(Column::integer("id").primary_key().auto_increment())
        .column(Column::text("text").default(""))
        .column(Column::integer("completed").default(0i64));
    let executed = migrate_table(&table, MigrateBehaviour::CreateIfNotExists, true, "now");
    let create = &executed
        .iter()
        .find(|s| s.sql.to_lowercase().contains("create table if not exists"))
        .unwrap()
        .sql;

    assert!(create.contains("create table if not exists \"todos\""));
    assert!(create.contains("\"id\" integer primary key autoincrement"));
    assert!(create.contains(" default ''"));
    assert!(!create.contains("PRIMARY KEY ('id')"));
    assert!(
        !["'todos'", "'id'", "'text'"]
            .iter()
            .any(|s| create.contains(s))
    );
    assert_eq!(executed.len(), 1);
}

#[test]
fn persists_full_textual_table_fingerprints() {
    let table = Table::new("todos").column(Column::text("id").primary_key());
    let executed = migrate_table(&table, MigrateBehaviour::CreateIfNotExists, false, "now");
    let meta = executed
        .iter()
        .find(|s| s.sql.contains(SCHEMA_META_TABLE))
        .unwrap();
    assert_eq!(meta.binds[1], SqlValue::Text(table_fingerprint(&table)));

    let schema_meta = state_tables()
        .into_iter()
        .find(|t| t.name == SCHEMA_META_TABLE)
        .unwrap();
    assert_eq!(
        schema_meta
            .columns
            .iter()
            .find(|c| c.name == "schemaHash")
            .unwrap()
            .ty,
        ColumnType::Text
    );
}
