//! Port of packages/@livestore/wa-sqlite/test/api.test.js (api_exec.js, api_misc.js, api_statements.js) for the
//! default build without a custom VFS: each test opens `demo` as a file, like wa-sqlite's default VFS.
#![allow(clippy::approx_constant)]

mod wa_sqlite;

use fallible_iterator::FallibleIterator;
use rusqlite::{Batch, Connection, limits::Limit, types::Value, types::ValueRef};
use wa_sqlite::{exec, open_demo};

fn col_type(v: ValueRef) -> rusqlite::types::Type {
    v.data_type()
}

// --- api_exec ---

#[test]
fn should_execute_a_query() {
    let db = open_demo("should_execute_a_query");
    db.execute_batch("CREATE TABLE t(x)").unwrap();
    db.execute_batch("INSERT INTO t VALUES (1), (2), (3)")
        .unwrap();
    assert_eq!(db.changes(), 3);
}

#[test]
fn should_execute_multiple_queries() {
    let db = open_demo("should_execute_multiple_queries");
    db.execute_batch("CREATE TABLE t(x);\nINSERT INTO t VALUES (1), (2), (3);")
        .unwrap();
    assert_eq!(db.changes(), 3);
}

#[test]
fn should_return_query_results_via_callback() {
    let db = open_demo("should_return_query_results_via_callback");
    let (mut columns, mut rows) = (Vec::new(), Vec::new());
    exec(
        &db,
        "CREATE TABLE t(x);\nINSERT INTO t VALUES (1), (2), (3);\nSELECT * FROM t ORDER BY x;",
        |row, cols| {
            if !cols.is_empty() {
                columns = cols;
                rows.push(row);
            }
        },
    )
    .unwrap();
    assert_eq!(columns, vec!["x"]);
    assert_eq!(
        rows,
        vec![
            vec![Value::Integer(1)],
            vec![Value::Integer(2)],
            vec![Value::Integer(3)]
        ]
    );
}

#[test]
fn should_allow_a_transaction_to_span_multiple_calls() {
    let db = open_demo("should_allow_a_transaction_to_span_multiple_calls");
    assert!(db.is_autocommit());
    db.execute_batch("BEGIN TRANSACTION").unwrap();
    assert!(!db.is_autocommit());
    db.execute_batch(
        "CREATE TABLE t AS
        WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt LIMIT 100)
        SELECT x FROM cnt;",
    )
    .unwrap();
    assert!(!db.is_autocommit());
    db.execute_batch("COMMIT").unwrap();
    assert!(db.is_autocommit());
}

// --- api_misc ---

#[test]
fn should_return_the_library_version() {
    let version = rusqlite::version();
    assert!(
        version.split('.').count() == 3 && version.split('.').all(|c| c.parse::<u32>().is_ok())
    );
    let components: String = version
        .split('.')
        .enumerate()
        .map(|(i, c)| {
            if i > 0 {
                format!("{c:0>3}")
            } else {
                c.to_string()
            }
        })
        .collect();
    assert_eq!(rusqlite::version_number().to_string(), components);
}

#[test]
fn should_constrain_usage() {
    let db = open_demo("should_constrain_usage");
    let sql = "SELECT 1, 2, 3, 4, 5, 6;";
    exec(&db, sql, |_, _| {}).unwrap();

    let previous = db.set_limit(Limit::SQLITE_LIMIT_COLUMN, 5).unwrap();
    assert!(previous > 0);
    let err = exec(&db, sql, |_, _| {}).unwrap_err();
    assert!(err.to_string().contains("too many columns"), "{err}");

    assert_eq!(
        db.set_limit(Limit::SQLITE_LIMIT_COLUMN, previous).unwrap(),
        5
    );
    exec(&db, sql, |_, _| {}).unwrap();
}

// --- api_statements ---

#[test]
fn should_iterate() {
    let db = open_demo("should_iterate");
    let sql = [
        "PRAGMA journal_mode",
        "CREATE TABLE t(x)",
        "SELECT * FROM sqlite_master",
    ];
    let joined = sql.join(";\n");
    let mut batch = Batch::new(&db, &joined);
    let mut count = 0;
    while let Some(mut stmt) = batch.next().unwrap() {
        let query = stmt.expanded_sql().unwrap();
        assert!(query.contains(sql[count]));
        count += 1;
        stmt.raw_query().next().unwrap();
    }
    assert_eq!(count, sql.len());
}

/// Binds `value` to `SELECT ?`, steps, and checks column count, type and value (both TS loops: typed + generic bind).
fn check_bind(db: &Connection, value: Value, expected: Value) {
    let mut stmt = db.prepare("SELECT ?").unwrap();
    stmt.raw_bind_parameter(1, &value).unwrap();
    assert_eq!(stmt.column_count(), 1);
    let mut rows = stmt.raw_query();
    let mut seen = 0;
    while let Some(row) = rows.next().unwrap() {
        assert_eq!(col_type(row.get_ref(0).unwrap()), expected.data_type());
        assert_eq!(row.get::<_, Value>(0).unwrap(), expected);
        seen += 1;
    }
    assert_eq!(seen, 1);
}

#[test]
fn should_bind_blob() {
    let db = open_demo("should_bind_blob");
    check_bind(
        &db,
        Value::Blob(vec![1, 2, 3, 4, 5]),
        Value::Blob(vec![1, 2, 3, 4, 5]),
    );
}

#[test]
fn should_bind_double() {
    let db = open_demo("should_bind_double");
    check_bind(
        &db,
        Value::Real(std::f64::consts::PI),
        Value::Real(std::f64::consts::PI),
    );
}

#[test]
fn should_bind_int() {
    let db = open_demo("should_bind_int");
    check_bind(&db, Value::Integer(42), Value::Integer(42));
}

#[test]
fn should_bind_int64() {
    let db = open_demo("should_bind_int64");
    let value = (1i64 << 53) + 1; // Number.MAX_SAFE_INTEGER + 1
    check_bind(&db, Value::Integer(value), Value::Integer(value));
}

#[test]
fn should_bind_null() {
    let db = open_demo("should_bind_null");
    assert_eq!(db.prepare("SELECT ?").unwrap().parameter_count(), 1);
    check_bind(&db, Value::Null, Value::Null);
}

#[test]
fn should_bind_text() {
    let db = open_demo("should_bind_text");
    check_bind(
        &db,
        Value::Text("Hello, world!".into()),
        Value::Text("Hello, world!".into()),
    );
}

#[test]
fn should_bind_boolean() {
    let db = open_demo("should_bind_boolean");
    let mut stmt = db.prepare("SELECT ?").unwrap();
    stmt.raw_bind_parameter(1, true).unwrap();
    let mut rows = stmt.raw_query();
    let row = rows.next().unwrap().unwrap();
    assert_eq!(
        col_type(row.get_ref(0).unwrap()),
        rusqlite::types::Type::Integer
    );
    assert_eq!(row.get::<_, i64>(0).unwrap(), 1);
}

fn expected_collection_row() -> Vec<Value> {
    vec![
        Value::Blob(vec![8, 6, 7, 5, 3, 0, 9]),
        Value::Real(std::f64::consts::PI),
        Value::Integer(42),
        Value::Null,
        Value::Text("foobar".into()),
    ]
}

#[test]
fn should_bind_collection_array() {
    let db = open_demo("should_bind_collection_array");
    let mut stmt = db.prepare("VALUES (?, ?, ?, ?, ?)").unwrap();
    assert_eq!(
        stmt.column_names(),
        vec!["column1", "column2", "column3", "column4", "column5"]
    );
    let row = expected_collection_row();
    for (i, v) in row.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, v).unwrap();
    }
    assert_eq!(stmt.column_count(), 5);
    let mut rows = stmt.raw_query();
    let got = rows.next().unwrap().unwrap();
    assert_eq!(
        (0..5)
            .map(|i| got.get::<_, Value>(i).unwrap())
            .collect::<Vec<_>>(),
        row
    );
}

#[test]
fn should_bind_collection_object() {
    let db = open_demo("should_bind_collection_object");
    let mut stmt = db
        .prepare("VALUES (:cBlob, :cDouble, :cInt, :cNull, :cText)")
        .unwrap();
    let names = [":cBlob", ":cDouble", ":cInt", ":cNull", ":cText"];
    assert_eq!(stmt.parameter_count(), 5);
    for (i, name) in names.iter().enumerate() {
        assert_eq!(stmt.parameter_name(i + 1), Some(*name));
    }
    let row = expected_collection_row();
    for (name, v) in names.iter().zip(&row) {
        stmt.raw_bind_parameter(*name, v).unwrap();
    }
    assert_eq!(stmt.column_count(), 5);
    let mut rows = stmt.raw_query();
    let got = rows.next().unwrap().unwrap();
    assert_eq!(
        (0..5)
            .map(|i| got.get::<_, Value>(i).unwrap())
            .collect::<Vec<_>>(),
        row
    );
}

#[test]
fn should_allow_unscoped_lifetime() {
    let db = open_demo("should_allow_unscoped_lifetime");
    db.execute_batch("CREATE TABLE t AS VALUES ('foo', 0), ('bar', 1), ('baz', 2);")
        .unwrap();
    let mut stmt = db
        .prepare("SELECT column2 FROM t WHERE column1 = ?")
        .unwrap();

    stmt.raw_bind_parameter(1, "foo").unwrap();
    {
        let mut rows = stmt.raw_query();
        assert_eq!(rows.next().unwrap().unwrap().get::<_, i64>(0).unwrap(), 0);
    } // dropping `Rows` resets the statement

    stmt.raw_bind_parameter(1, "bar").unwrap();
    let mut rows = stmt.raw_query();
    assert_eq!(rows.next().unwrap().unwrap().get::<_, i64>(0).unwrap(), 1);
    assert!(rows.next().unwrap().is_none());
    drop(rows);
    stmt.finalize().unwrap();
}

#[test]
fn should_clear_bindings() {
    let db = open_demo("should_clear_bindings");
    let mut stmt = db.prepare("SELECT ?").unwrap();
    stmt.raw_bind_parameter(1, 42).unwrap();
    assert_eq!(
        stmt.raw_query()
            .next()
            .unwrap()
            .unwrap()
            .get::<_, Value>(0)
            .unwrap(),
        Value::Integer(42)
    );

    stmt.clear_bindings();
    assert_ne!(
        stmt.raw_query()
            .next()
            .unwrap()
            .unwrap()
            .get::<_, Value>(0)
            .unwrap(),
        Value::Integer(42)
    );
}
