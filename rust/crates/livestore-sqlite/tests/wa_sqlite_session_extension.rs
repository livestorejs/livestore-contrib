//! Port of tests/wa-sqlite/test/unit/session-extension.test.ts. Changesets travel as bytes like in wa-sqlite.
use std::sync::{Arc, Mutex};

use rusqlite::{
    Connection,
    session::{ConflictAction, ConflictType, Session, invert_strm},
};

fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            email TEXT,
            age INTEGER
        );
        INSERT INTO users (name, email, age) VALUES ('Alice', 'alice@example.com', 30);",
    )
    .unwrap();
    db
}

fn changeset(session: &mut Session) -> Vec<u8> {
    let mut out = Vec::new();
    session.changeset_strm(&mut out).unwrap();
    out
}

fn invert(changeset: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    invert_strm(&mut &changeset[..], &mut out).unwrap();
    out
}

/// `sqlite3.changeset_apply(db, changeset, xFilter, xConflict)`.
fn apply(
    db: &Connection,
    changeset: &[u8],
    filter: Option<fn(&str) -> bool>,
    conflict: impl Fn(ConflictType) -> ConflictAction + Send + 'static,
) -> rusqlite::Result<()> {
    db.apply_strm(&mut &changeset[..], filter, move |e, _| conflict(e))
}

fn ages(db: &Connection, sql: &str) -> Vec<i64> {
    db.prepare(sql)
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn should_create_and_manage_session_objects() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    drop(session);
}

#[test]
fn should_track_changes_when_session_is_enabled() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute_batch(
        "INSERT INTO users (name, email, age) VALUES ('Bob', 'bob@example.com', 25);
         UPDATE users SET age = 31 WHERE name = 'Alice';",
    )
    .unwrap();
    session.set_enabled(false);

    assert_ne!(changeset(&mut session), Vec::<u8>::new());
}

#[test]
fn should_not_track_changes_when_session_is_disabled() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('Charlie', 'charlie@example.com', 35)",
        [],
    )
    .unwrap();

    // TS only checks that a changeset (possibly non-empty) comes back.
    let _ = changeset(&mut session);
}

#[test]
fn should_apply_changeset_to_revert_changes() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    let initial = ages(&db, "SELECT age FROM users ORDER BY id");

    session.set_enabled(true);
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('Dave', 'dave@example.com', 28)",
        [],
    )
    .unwrap();
    db.execute("UPDATE users SET age = 32 WHERE name = 'Alice'", [])
        .unwrap();
    session.set_enabled(false);

    let changed: Vec<(String, i64)> = db
        .prepare("SELECT name, age FROM users ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(changed.len(), 2);
    assert_eq!(changed[0].1, 32);
    assert_eq!(changed[1].0, "Dave");

    let inverted = invert(&changeset(&mut session));
    apply(&db, &inverted, None, |e| match e {
        ConflictType::SQLITE_CHANGESET_DATA | ConflictType::SQLITE_CHANGESET_CONFLICT => {
            ConflictAction::SQLITE_CHANGESET_REPLACE
        }
        _ => ConflictAction::SQLITE_CHANGESET_OMIT,
    })
    .unwrap();

    let reverted = ages(&db, "SELECT age FROM users ORDER BY id");
    assert_eq!(reverted.len(), initial.len());
    assert_eq!(reverted[0], initial[0]);
}

#[test]
fn should_handle_multiple_independent_sessions() {
    let db = db();
    let mut session1 = Session::new(&db).unwrap();
    let mut session2 = Session::new(&db).unwrap();
    session1.attach(None::<&str>).unwrap();
    session2.attach(None::<&str>).unwrap();

    session1.set_enabled(true);
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('Session1User', 'session1@example.com', 25)",
        [],
    )
    .unwrap();
    session1.set_enabled(false);

    session2.set_enabled(true);
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('Session2User', 'session2@example.com', 30)",
        [],
    )
    .unwrap();
    session2.set_enabled(false);

    let changeset1 = changeset(&mut session1);
    let changeset2 = changeset(&mut session2);
    assert_ne!(changeset1, changeset2);
    assert_ne!(changeset1, Vec::<u8>::new());
    assert_ne!(changeset2, Vec::<u8>::new());
}

#[test]
fn should_track_specific_table_changes_when_attached_to_specific_table() {
    let db = db();
    db.execute(
        "CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL)",
        [],
    )
    .unwrap();
    let mut session = Session::new(&db).unwrap();
    session.attach(Some("products")).unwrap();
    session.set_enabled(true);
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('John', 'john@example.com', 40)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO products (name, price) VALUES ('Laptop', 999.99)",
        [],
    )
    .unwrap();
    session.set_enabled(false);

    assert_ne!(changeset(&mut session), Vec::<u8>::new());
}

#[test]
fn should_handle_session_lifecycle_properly() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.set_enabled(true);
    session.set_enabled(false);
    session.set_enabled(true);
    session.set_enabled(false);

    assert_eq!(changeset(&mut session), changeset(&mut session));
}

/// Applies `changeset` recording each conflict type, resolving with `action`.
fn apply_recording(
    db: &Connection,
    changeset: &[u8],
    action: fn() -> ConflictAction,
) -> Vec<ConflictType> {
    let conflicts = Arc::new(Mutex::new(Vec::new()));
    let seen = conflicts.clone();
    apply(db, changeset, None, move |e| {
        seen.lock().unwrap().push(e);
        action()
    })
    .unwrap();
    Arc::try_unwrap(conflicts).unwrap().into_inner().unwrap()
}

#[test]
fn should_invoke_xconflict_callback_on_data_conflict() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute("UPDATE users SET age = 40 WHERE name = 'Alice'", [])
        .unwrap();
    session.set_enabled(false);
    let cs = changeset(&mut session);

    db.execute("UPDATE users SET age = 99 WHERE name = 'Alice'", [])
        .unwrap();
    let conflicts = apply_recording(&db, &cs, || ConflictAction::SQLITE_CHANGESET_REPLACE);

    assert_eq!(conflicts, vec![ConflictType::SQLITE_CHANGESET_DATA]);
    assert_eq!(
        ages(&db, "SELECT age FROM users WHERE name = 'Alice'"),
        vec![40]
    );
}

#[test]
fn should_invoke_xconflict_callback_on_conflict_insert_with_existing_pk() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute(
        "INSERT INTO users (id, name, email, age) VALUES (100, 'Eve', 'eve@example.com', 25)",
        [],
    )
    .unwrap();
    session.set_enabled(false);
    let cs = changeset(&mut session);

    db.execute("DELETE FROM users WHERE id = 100", []).unwrap();
    db.execute("INSERT INTO users (id, name, email, age) VALUES (100, 'Mallory', 'mallory@example.com', 35)", [])
        .unwrap();
    let conflicts = apply_recording(&db, &cs, || ConflictAction::SQLITE_CHANGESET_REPLACE);

    assert_eq!(conflicts, vec![ConflictType::SQLITE_CHANGESET_CONFLICT]);
    let name: String = db
        .query_row("SELECT name FROM users WHERE id = 100", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name, "Eve");
}

#[test]
fn should_invoke_xconflict_callback_on_notfound() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute("UPDATE users SET age = 50 WHERE name = 'Alice'", [])
        .unwrap();
    session.set_enabled(false);
    let inverted = invert(&changeset(&mut session));

    db.execute("DELETE FROM users WHERE name = 'Alice'", [])
        .unwrap();
    let conflicts = apply_recording(&db, &inverted, || ConflictAction::SQLITE_CHANGESET_OMIT);

    assert_eq!(conflicts, vec![ConflictType::SQLITE_CHANGESET_NOTFOUND]);
}

#[test]
fn should_support_xconflict_returning_omit_to_skip_conflicting_changes() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute("UPDATE users SET age = 40 WHERE name = 'Alice'", [])
        .unwrap();
    session.set_enabled(false);
    let cs = changeset(&mut session);

    db.execute("UPDATE users SET age = 99 WHERE name = 'Alice'", [])
        .unwrap();
    apply(&db, &cs, None, |_| ConflictAction::SQLITE_CHANGESET_OMIT).unwrap();

    assert_eq!(
        ages(&db, "SELECT age FROM users WHERE name = 'Alice'"),
        vec![99]
    );
}

#[test]
fn should_support_xfilter_to_exclude_tables_from_changeset_application() {
    let db = db();
    db.execute(
        "CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL)",
        [],
    )
    .unwrap();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('Filtered', 'filtered@example.com', 50)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO products (name, price) VALUES ('Widget', 9.99)",
        [],
    )
    .unwrap();
    session.set_enabled(false);
    let cs = changeset(&mut session);

    db.execute("DELETE FROM users WHERE name = 'Filtered'", [])
        .unwrap();
    db.execute("DELETE FROM products WHERE name = 'Widget'", [])
        .unwrap();
    apply(&db, &cs, Some(|table| table != "users"), |_| {
        ConflictAction::SQLITE_CHANGESET_REPLACE
    })
    .unwrap();

    let count = |sql| db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(
        count("SELECT count(*) FROM users WHERE name = 'Filtered'"),
        0
    );
    assert_eq!(
        count("SELECT count(*) FROM products WHERE name = 'Widget'"),
        1
    );
}

#[test]
fn should_return_sqlite_ok_when_changeset_applies_without_conflicts() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('NoConflict', 'nc@example.com', 20)",
        [],
    )
    .unwrap();
    session.set_enabled(false);
    let cs = changeset(&mut session);

    db.execute("DELETE FROM users WHERE name = 'NoConflict'", [])
        .unwrap();
    assert!(apply(&db, &cs, None, |_| ConflictAction::SQLITE_CHANGESET_OMIT).is_ok());
}

#[test]
fn should_throw_sqlite_abort_when_xconflict_returns_abort() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute("UPDATE users SET age = 40 WHERE name = 'Alice'", [])
        .unwrap();
    session.set_enabled(false);
    let cs = changeset(&mut session);

    db.execute("UPDATE users SET age = 99 WHERE name = 'Alice'", [])
        .unwrap();
    let err = apply(&db, &cs, None, |_| ConflictAction::SQLITE_CHANGESET_ABORT).unwrap_err();
    assert_eq!(
        err.sqlite_error_code(),
        Some(rusqlite::ErrorCode::OperationAborted)
    );

    assert_eq!(
        ages(&db, "SELECT age FROM users WHERE name = 'Alice'"),
        vec![99]
    );
}

#[test]
fn should_handle_complex_changeset_operations() {
    let db = db();
    let mut session = Session::new(&db).unwrap();
    session.attach(None::<&str>).unwrap();
    session.set_enabled(true);
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('Test1', 'test1@example.com', 20)",
        [],
    )
    .unwrap();
    let inserted_id: i64 = db
        .query_row("SELECT last_insert_rowid() as id", [], |r| r.get(0))
        .unwrap();
    db.execute("UPDATE users SET age = 21 WHERE id = ?", [inserted_id])
        .unwrap();
    db.execute(
        "INSERT INTO users (name, email, age) VALUES ('Test2', 'test2@example.com', 22)",
        [],
    )
    .unwrap();
    session.set_enabled(false);

    let cs = changeset(&mut session);
    assert_ne!(cs, Vec::<u8>::new());
    assert_ne!(invert(&cs), Vec::<u8>::new());
}
