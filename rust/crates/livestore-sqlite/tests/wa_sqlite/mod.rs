//! Shared helpers for the ports of `LiveStore`'s wa-sqlite tests.
#![allow(dead_code)]

use std::path::PathBuf;

use fallible_iterator::FallibleIterator;
use rusqlite::{Batch, Connection, types::Value};

/// `sqlite3.exec(db, sql, callback)`: runs every statement, calling `on_row(row, columns)` per result row.
pub fn exec(
    conn: &Connection,
    sql: &str,
    mut on_row: impl FnMut(Vec<Value>, Vec<String>),
) -> rusqlite::Result<()> {
    let mut batch = Batch::new(conn, sql);
    while let Some(mut stmt) = batch.next()? {
        let columns: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
        let mut rows = stmt.raw_query();
        while let Some(row) = rows.next()? {
            on_row(
                (0..columns.len())
                    .map(|i| row.get(i))
                    .collect::<rusqlite::Result<_>>()?,
                columns.clone(),
            );
        }
    }
    Ok(())
}

/// Single-value variant of [`exec`] for `SELECT x` style probes (last row wins, like the TS callbacks).
pub fn exec_value(conn: &Connection, sql: &str) -> Option<Value> {
    let mut value = None;
    exec(conn, sql, |row, _| value = row.into_iter().next()).unwrap();
    value
}

/// Fresh file path standing in for wa-sqlite's `open_v2('demo')` on its default (file-backed) VFS.
pub fn demo_path(test: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("wa-sqlite")
        .join(test);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("demo")
}

pub fn open_demo(test: &str) -> Connection {
    Connection::open(demo_path(test)).unwrap()
}
