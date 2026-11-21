//! Port of packages/@livestore/wa-sqlite/test/sql.test.js (`sql_0001..sql_0005`) for the default build on a file DB.
//! wa-sqlite's default config skips `sql_0004` (not persistent) and `sql_0005` (single connection); a native file
//! is both, so they run here too.
mod wa_sqlite;

use std::{process::Command, thread};

use rusqlite::{Connection, types::Value};
use wa_sqlite::{demo_path, exec, exec_value, open_demo};

fn integrity_check(db: &Connection) {
    assert_eq!(
        exec_value(db, "PRAGMA integrity_check;"),
        Some(Value::Text("ok".into()))
    );
}

#[test]
fn should_rollback_a_transaction() {
    let db = open_demo("should_rollback_a_transaction");
    let count = exec_value(
        &db,
        "CREATE TABLE foo (x PRIMARY KEY);
        INSERT INTO foo VALUES ('foo'), ('bar'), ('baz');
        SELECT COUNT(*) FROM foo;",
    );
    assert_eq!(count, Some(Value::Integer(3)));

    let count = exec_value(
        &db,
        "BEGIN TRANSACTION;
        WITH numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers LIMIT 100)
          INSERT INTO foo SELECT * FROM numbers;
        SELECT COUNT(*) FROM foo;",
    );
    assert_eq!(count, Some(Value::Integer(103)));

    let count = exec_value(&db, "ROLLBACK;\nSELECT COUNT(*) FROM foo;");
    assert_eq!(count, Some(Value::Integer(3)));
    integrity_check(&db);
}

#[test]
fn should_vacuum_to_minimize_page_count() {
    let db = open_demo("should_vacuum_to_minimize_page_count");
    db.execute_batch(
        "CREATE TABLE t AS
        WITH numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers LIMIT 10000)
        SELECT n FROM numbers;",
    )
    .unwrap();
    let Some(Value::Integer(before)) = exec_value(&db, "PRAGMA page_count;") else {
        panic!()
    };
    // Upstream deletes non-squares with sqrt/floor from wa-sqlite's extension-functions.c; same rows here.
    db.execute_batch("DELETE FROM t WHERE n NOT IN (SELECT n * n FROM t);")
        .unwrap();
    db.execute_batch("VACUUM;").unwrap();
    let Some(Value::Integer(after)) = exec_value(&db, "PRAGMA page_count;") else {
        panic!()
    };
    assert!(after < before);
    integrity_check(&db);
}

fn vacuum_page_size(test: &str, new_size: i64) {
    let db = open_demo(test);
    db.execute_batch(
        "PRAGMA page_size=8192;
        CREATE TABLE t AS
        WITH numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers LIMIT 10000)
        SELECT n FROM numbers;",
    )
    .unwrap();
    assert_eq!(
        exec_value(&db, "PRAGMA page_size;"),
        Some(Value::Integer(8192))
    );
    db.execute_batch(&format!("PRAGMA page_size={new_size};\nVACUUM;"))
        .unwrap();
    assert_eq!(
        exec_value(&db, "PRAGMA page_size;"),
        Some(Value::Integer(new_size))
    );
    integrity_check(&db);
}

#[test]
fn should_vacuum_to_decrease_page_size() {
    vacuum_page_size("should_vacuum_to_decrease_page_size", 4096);
}

#[test]
fn should_vacuum_to_increase_page_size() {
    vacuum_page_size("should_vacuum_to_increase_page_size", 16384);
}

const CRASH_PHASE: &str = "WA_SQLITE_SQL_0004_CRASH_DB";

/// The TS test terminates the worker mid-transaction; here a child process exits without closing the connection.
#[test]
fn should_recover_after_crash() {
    if let Ok(path) = std::env::var(CRASH_PHASE) {
        let db = Connection::open(path).unwrap();
        db.execute_batch(
            "PRAGMA cache_size=0;\nCREATE TABLE t(x);\nINSERT INTO t VALUES (1), (2), (3);",
        )
        .unwrap();
        assert_eq!(
            exec_value(&db, "SELECT sum(x) FROM t;"),
            Some(Value::Integer(6))
        );
        integrity_check(&db);
        db.execute_batch(
            "BEGIN TRANSACTION;
            WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt LIMIT 10000)
            INSERT INTO t SELECT * FROM cnt;",
        )
        .unwrap();
        std::process::exit(0);
    }

    let path = demo_path("should_recover_after_crash");
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["should_recover_after_crash", "--exact", "--nocapture"])
        .env(CRASH_PHASE, &path)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(
        path.with_file_name("demo-journal").exists(),
        "crash must leave a hot journal"
    );

    let db = Connection::open(&path).unwrap();
    assert_eq!(
        exec_value(&db, "SELECT sum(x) FROM t;"),
        Some(Value::Integer(6))
    );
    integrity_check(&db);
    db.execute_batch("INSERT INTO t VALUES (4), (5);").unwrap();
    assert_eq!(
        exec_value(&db, "SELECT sum(x) FROM t;"),
        Some(Value::Integer(15))
    );
}

#[test]
fn should_transact_atomically() {
    let path = demo_path("should_transact_atomically");
    let instances: Vec<Connection> = (0..8).map(|_| Connection::open(&path).unwrap()).collect();
    instances[0]
        .execute_batch(
            "BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS t(key PRIMARY KEY, value);
            INSERT OR IGNORE INTO t VALUES ('foo', 0);
            COMMIT;",
        )
        .unwrap();

    let iterations = 32;
    let handles: Vec<_> = instances
        .into_iter()
        .map(|db| {
            thread::spawn(move || {
                (0..iterations)
                    .map(|_| {
                        transact(
                            &db,
                            "BEGIN IMMEDIATE;
                            UPDATE t SET value = value + 1 WHERE key = 'foo';
                            SELECT value FROM t WHERE key = 'foo';
                            COMMIT;",
                        )
                    })
                    .collect::<Vec<i64>>()
            })
        })
        .collect();
    let mut values: Vec<i64> = handles
        .into_iter()
        .flat_map(|h| h.join().unwrap())
        .collect();
    values.sort_unstable();
    values.dedup();

    assert_eq!(values.len(), 8 * iterations);
    assert_eq!(
        values.last().copied(),
        Some(i64::try_from(values.len()).unwrap())
    );
}

/// Retries while another connection holds the write lock (TS: `e.message === 'database is locked'`).
fn transact(db: &Connection, sql: &str) -> i64 {
    loop {
        let mut rows = Vec::new();
        match exec(db, sql, |row, _| rows.push(row)) {
            Ok(()) => match rows[0][0] {
                Value::Integer(v) => return v,
                ref other => panic!("{other:?}"),
            },
            Err(e) if e.sqlite_error_code() == Some(rusqlite::ErrorCode::DatabaseBusy) => {}
            Err(e) => panic!("{e}"),
        }
    }
}
