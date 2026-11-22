use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

use livestore_sqlite::Error;
use livestore_sqlite::helper::with_savepoint;
use rusqlite::Connection;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
use serde_json::{Value, json};

#[test]
fn rolls_back_failed_effects() {
    let db = setup();
    let result: Result<(), Error> = with_savepoint(&db, || {
        db.execute_batch("INSERT INTO test (id, value) VALUES (1, 'rolled-back')")?;
        Err(Error::Invariant("rollback".into()))
    });
    assert!(result.is_err());
    assert_eq!(values(&db), Vec::<serde_json::Value>::new());
}

#[test]
fn returns_sqlite_error_without_cleanup_when_savepoint_acquisition_fails() {
    let db = setup();
    let operations = Arc::new(Mutex::new(Vec::new()));
    let ops = operations.clone();
    db.authorizer(Some(move |ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Savepoint { operation, .. } => {
            ops.lock().unwrap().push(operation);
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }));
    let mut effect_ran = false;
    let error = with_savepoint(&db, || -> Result<(), Error> {
        effect_ran = true;
        Ok(())
    })
    .unwrap_err();
    assert_statement(&error, r"^SAVEPOINT livestore_savepoint_\d+$");
    assert!(!effect_ran);
    assert_eq!(
        *operations.lock().unwrap(),
        vec![TransactionOperation::Begin]
    );
}

#[test]
fn returns_sqlite_error_when_releasing_the_savepoint_fails() {
    let db = setup();
    deny(&db, TransactionOperation::Release);
    let error = with_savepoint(&db, || -> Result<(), Error> { Ok(()) }).unwrap_err();
    assert_statement(&error, r"^RELEASE SAVEPOINT livestore_savepoint_\d+$");
}

#[test]
fn returns_sqlite_error_when_rolling_back_to_the_savepoint_fails() {
    let db = setup();
    deny(&db, TransactionOperation::Rollback);
    let error = with_savepoint(&db, || -> Result<(), Error> {
        Err(Error::Invariant("wrapped failure".into()))
    })
    .unwrap_err();
    assert_statement(&error, r"^ROLLBACK TO SAVEPOINT livestore_savepoint_\d+$");
}

#[test]
fn composes_inside_an_outer_transaction() {
    let db = setup();
    db.execute_batch("BEGIN TRANSACTION").unwrap();
    db.execute_batch("INSERT INTO test (id, value) VALUES (1, 'outer')")
        .unwrap();
    with_savepoint(&db, || -> Result<(), Error> {
        db.execute_batch("INSERT INTO test (id, value) VALUES (2, 'inner')")?;
        Ok(())
    })
    .unwrap();
    let _ = with_savepoint(&db, || -> Result<(), Error> {
        db.execute_batch("INSERT INTO test (id, value) VALUES (3, 'rolled-back')")?;
        Err(Error::Invariant("rollback inner".into()))
    });
    db.execute_batch("COMMIT").unwrap();
    assert_eq!(
        id_values(&db),
        vec![
            json!({"id": 1, "value": "outer"}),
            json!({"id": 2, "value": "inner"})
        ]
    );
}

#[test]
fn rolls_back_and_releases_on_interruption() {
    let db = setup();
    let interrupted = catch_unwind(AssertUnwindSafe(|| {
        with_savepoint(&db, || -> Result<(), Error> {
            db.execute_batch("INSERT INTO test (id, value) VALUES (1, 'interrupted')")?;
            panic!("interrupted");
        })
    }));
    assert!(interrupted.is_err());
    assert_eq!(values(&db), Vec::<serde_json::Value>::new());

    db.execute_batch("INSERT INTO test (id, value) VALUES (2, 'after-interrupt')")
        .unwrap();
    assert_eq!(values(&db), vec![json!({"value": "after-interrupt"})]);
}

#[test]
fn runs_nested_success_and_rollback_branches_synchronously() {
    let db = setup();
    let result = with_savepoint(&db, || -> Result<&str, Error> {
        db.execute_batch("INSERT INTO test (id, value) VALUES (1, 'outer-before')")?;
        let _ = with_savepoint(&db, || -> Result<(), Error> {
            db.execute_batch("INSERT INTO test (id, value) VALUES (2, 'inner-rolled-back')")?;
            Err(Error::Invariant("rollback inner".into()))
        });
        db.execute_batch("INSERT INTO test (id, value) VALUES (3, 'outer-after')")?;
        Ok("result")
    })
    .unwrap();
    assert_eq!(result, "result");
    assert_eq!(
        id_values(&db),
        vec![
            json!({"id": 1, "value": "outer-before"}),
            json!({"id": 3, "value": "outer-after"})
        ]
    );
}

fn setup() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)")
        .unwrap();
    db
}

fn deny(db: &Connection, denied: TransactionOperation) {
    db.authorizer(Some(move |ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Savepoint { operation, .. } if operation == denied => Authorization::Deny,
        _ => Authorization::Allow,
    }));
}

fn assert_statement(error: &Error, pattern: &str) {
    let Error::SqliteQuery { sql, .. } = error else {
        panic!("expected SqliteError, got {error:?}")
    };
    let re = pattern
        .trim_start_matches('^')
        .trim_end_matches('$')
        .replace(r"\d+", "");
    let digits = sql
        .strip_prefix(&re)
        .unwrap_or_else(|| panic!("{sql} does not match {pattern}"));
    assert!(
        !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()),
        "{sql} does not match {pattern}"
    );
}

fn values(db: &Connection) -> Vec<Value> {
    rows(db, "SELECT value FROM test")
}

fn id_values(db: &Connection) -> Vec<Value> {
    rows(db, "SELECT id, value FROM test ORDER BY id ASC")
}

fn rows(db: &Connection, sql: &str) -> Vec<Value> {
    livestore_sqlite::db::query_rows(db, sql)
        .unwrap()
        .into_iter()
        .map(Value::Object)
        .collect()
}
