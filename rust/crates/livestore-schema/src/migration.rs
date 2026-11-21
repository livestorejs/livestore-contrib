//! `migrateTable` (`schema-management/migrations.ts`) as a list of statements to execute.

use crate::fingerprint::{db_fingerprint, table_fingerprint};
use crate::system_tables::{SCHEMA_META_TABLE, state_tables};
use crate::table::Table;
use crate::value::{SqlStatement, SqlValue};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrateBehaviour {
    DropAndRecreate,
    CreateIfNotExists,
}

/// Statements `migrateTable` runs; the `__livestore_schema` row carries the table fingerprint unless
/// `skip_meta_table`.
#[must_use]
pub fn migrate_table(
    table: &Table,
    behaviour: MigrateBehaviour,
    skip_meta_table: bool,
    updated_at: &str,
) -> Vec<SqlStatement> {
    let mut out = vec![];
    if behaviour == MigrateBehaviour::DropAndRecreate {
        out.push(SqlStatement::new(
            format!("drop table if exists \"{}\"", table.name),
            [],
        ));
    }
    out.extend(
        table
            .ddl()
            .into_iter()
            .map(|sql| SqlStatement::new(sql, [])),
    );
    if !skip_meta_table {
        let hash = table_fingerprint(table);
        out.push(SqlStatement::new(
            format!(
                "INSERT INTO {SCHEMA_META_TABLE} (tableName, schemaHash, updatedAt) VALUES (?, ?, ?) ON CONFLICT (tableName) DO UPDATE SET schemaHash = excluded.schemaHash, updatedAt = excluded.updatedAt"
            ),
            [SqlValue::from(table.name.as_str()), hash.into(), updated_at.into()],
        ));
    }
    out
}

/// `makeState(...).sqlite.hash`: fingerprint over the system tables plus the app tables.
pub fn state_hash<'a>(tables: impl IntoIterator<Item = &'a Table>) -> String {
    let mut all = state_tables();
    all.extend(tables.into_iter().cloned());
    db_fingerprint(&all)
}
