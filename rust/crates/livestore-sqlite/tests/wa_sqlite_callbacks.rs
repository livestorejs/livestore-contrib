//! Port of packages/@livestore/wa-sqlite/test/callbacks.test.js. The TS suite runs once per async build (asyncify,
//! jspi); natively there is one build. The `async` variants are n/a (see rust/parity/status/sqlite.tsv).
#![allow(clippy::approx_constant)]

mod wa_sqlite;

use std::sync::{Arc, Mutex};

use rusqlite::{
    Connection,
    functions::{Aggregate, Context, FunctionFlags},
    hooks::{Action, AuthAction, Authorization},
    types::{Type, Value},
};
use wa_sqlite::{exec, exec_value};

fn db() -> Connection {
    Connection::open_in_memory().unwrap()
}

fn scalar_fn(
    db: &Connection,
    n_args: i32,
    f: impl Fn(&Context) -> rusqlite::Result<Value> + Send + 'static,
) {
    db.create_scalar_function(
        "fn",
        n_args,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        f,
    )
    .unwrap();
}

#[test]
fn should_return_an_int() {
    let db = db();
    scalar_fn(&db, 0, |_| Ok(Value::Integer(42)));
    assert_eq!(exec_value(&db, "SELECT fn()"), Some(Value::Integer(42)));
}

#[test]
fn should_return_an_int64() {
    let db = db();
    scalar_fn(&db, 0, |_| Ok(Value::Integer(0x7fff_ffff_ffff_ffff)));
    let value: i64 = db.query_row("SELECT fn()", [], |r| r.get(0)).unwrap();
    assert_eq!(value, 0x7fff_ffff_ffff_ffff);
}

#[test]
fn should_return_a_double() {
    let db = db();
    scalar_fn(&db, 0, |_| Ok(Value::Real(3.14)));
    assert_eq!(exec_value(&db, "SELECT fn()"), Some(Value::Real(3.14)));
}

#[test]
fn should_return_a_string() {
    let db = db();
    scalar_fn(&db, 0, |_| Ok(Value::Text("foobar".into())));
    assert_eq!(
        exec_value(&db, "SELECT fn()"),
        Some(Value::Text("foobar".into()))
    );
}

#[test]
fn should_return_a_blob() {
    let db = db();
    scalar_fn(&db, 0, |_| Ok(Value::Blob(vec![0x12, 0x34, 0x56])));
    assert_eq!(
        exec_value(&db, "SELECT fn()"),
        Some(Value::Blob(vec![0x12, 0x34, 0x56]))
    );
}

#[test]
fn should_return_null() {
    let db = db();
    scalar_fn(&db, 0, |_| Ok(Value::Null));
    assert_eq!(exec_value(&db, "SELECT fn()"), Some(Value::Null));
}

/// Shared assertions of the fixed/variable argument tests; panics inside the callback surface as SQL errors.
fn check_args(ctx: &Context, check_int_as_double: bool) -> rusqlite::Result<Value> {
    assert_eq!(ctx.len(), 5);
    assert_eq!(ctx.get_raw(0).data_type(), Type::Integer);
    assert_eq!(ctx.get::<i32>(0)?, 42);
    assert_eq!(ctx.get::<i64>(0)?, 42);
    if check_int_as_double {
        assert_eq!(ctx.get::<f64>(0)?, 42.0);
    }
    assert_eq!(ctx.get::<Value>(0)?, Value::Integer(42));

    assert_eq!(ctx.get_raw(1).data_type(), Type::Real);
    assert_eq!(ctx.get::<f64>(1)?, 3.14);

    assert_eq!(ctx.get_raw(2).data_type(), Type::Text);
    assert_eq!(ctx.get::<String>(2)?, "hello");

    assert_eq!(ctx.get_raw(3).data_type(), Type::Blob);
    assert_eq!(ctx.get::<Vec<u8>>(3)?, vec![0x12, 0x34, 0x56]);
    assert_eq!(ctx.get_raw(3).as_bytes()?.len(), 3);

    assert_eq!(ctx.get_raw(4).data_type(), Type::Null);
    Ok(Value::Null)
}

#[test]
fn should_pass_a_fixed_number_of_arguments() {
    let db = db();
    scalar_fn(&db, 5, |ctx| check_args(ctx, false));
    exec(
        &db,
        "SELECT fn(42, 3.14, 'hello', x'123456', NULL)",
        |_, _| {},
    )
    .unwrap();
}

#[test]
fn should_pass_a_variable_number_of_arguments() {
    let db = db();
    scalar_fn(&db, -1, |ctx| check_args(ctx, true));
    exec(
        &db,
        "SELECT fn(42, 3.14, 'hello', x'123456', NULL)",
        |_, _| {},
    )
    .unwrap();
}

struct Product(Arc<Mutex<f64>>);

impl Aggregate<(), Value> for Product {
    fn init(&self, _: &mut Context<'_>) -> rusqlite::Result<()> {
        Ok(())
    }
    fn step(&self, ctx: &mut Context<'_>, (): &mut ()) -> rusqlite::Result<()> {
        *self.0.lock().unwrap() *= ctx.get::<f64>(0)?;
        Ok(())
    }
    fn finalize(&self, _: &mut Context<'_>, _: Option<()>) -> rusqlite::Result<Value> {
        Ok(Value::Real(*self.0.lock().unwrap()))
    }
}

#[test]
fn should_create_an_aggregate_function() {
    let db = db();
    let product = Arc::new(Mutex::new(1.0));
    db.create_aggregate_function(
        "fn",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC,
        Product(product.clone()),
    )
    .unwrap();
    exec(
        &db,
        "SELECT fn(column1) FROM (VALUES (1), (2), (3), (4), (5));",
        |_, _| {},
    )
    .unwrap();
    assert_eq!(*product.lock().unwrap(), 120.0);
}

const CNT_100: &str = "CREATE TABLE t AS
    WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt LIMIT 100)
    SELECT x FROM cnt;";

#[test]
fn should_call_progress_handler() {
    let db = db();
    let count = Arc::new(Mutex::new(0));
    let seen = count.clone();
    db.progress_handler(
        1,
        Some(move || {
            *seen.lock().unwrap() += 1;
            false
        }),
    );
    db.execute_batch(CNT_100).unwrap();
    assert!(*count.lock().unwrap() > 0);
}

#[test]
fn should_call_authorizer() {
    let db = db();
    let authorizations = Arc::new(Mutex::new(Vec::new()));
    let seen = authorizations.clone();
    db.authorizer(Some(move |ctx: rusqlite::hooks::AuthContext<'_>| {
        if let AuthAction::CreateTable { table_name } = ctx.action {
            // wa-sqlite passes NULL arguments as ''.
            seen.lock().unwrap().push((
                table_name.to_string(),
                ctx.database_name.unwrap_or("").to_string(),
                ctx.accessor.unwrap_or("").to_string(),
            ));
        }
        Authorization::Allow
    }));
    db.execute_batch("CREATE TABLE t(x)").unwrap();
    assert_eq!(
        *authorizations.lock().unwrap(),
        vec![("t".to_string(), "main".to_string(), String::new())]
    );
}

#[test]
fn should_deny_authorization() {
    let db = db();
    db.authorizer(Some(|_: rusqlite::hooks::AuthContext<'_>| {
        Authorization::Deny
    }));
    let err = db.execute_batch("CREATE TABLE t(x)").unwrap_err();
    assert!(err.to_string().contains("not authorized"), "{err}");
}

#[test]
fn should_call_update_hook() {
    let db = db();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    db.update_hook(Some(
        move |action: Action, db: &str, tbl: &str, rowid: i64| {
            seen.lock()
                .unwrap()
                .push((action as i32, db.to_string(), tbl.to_string(), rowid));
        },
    ));
    let take = || std::mem::take(&mut *calls.lock().unwrap());
    let row = |code, rowid| (code, "main".to_string(), "t".to_string(), rowid);

    db.execute_batch(
        "CREATE TABLE t(i integer primary key, x);
        INSERT INTO t VALUES (1, 'foo'), (2, 'bar'), (12_345_678_987_654_321, 'baz');",
    )
    .unwrap();
    assert_eq!(
        take(),
        vec![row(18, 1), row(18, 2), row(18, 12_345_678_987_654_321)]
    );

    db.execute_batch("DELETE FROM t WHERE i = 2").unwrap();
    assert_eq!(take(), vec![row(9, 2)]);

    db.execute_batch("UPDATE t SET x = 'bar' WHERE i = 1")
        .unwrap();
    assert_eq!(take(), vec![row(23, 1)]);
}

/// Installs a commit hook that bumps `counter` and allows the commit.
fn counting_commit_hook(db: &Connection, counter: &Arc<Mutex<i32>>) {
    let counter = counter.clone();
    db.commit_hook(Some(move || {
        *counter.lock().unwrap() += 1;
        false
    }));
}

#[test]
fn should_call_commit_hook() {
    let db = db();
    let calls = Arc::new(Mutex::new(0));
    counting_commit_hook(&db, &calls);
    let take = || std::mem::take(&mut *calls.lock().unwrap());
    assert_eq!(take(), 0);

    db.execute_batch("CREATE TABLE t(i integer primary key, x);")
        .unwrap();
    assert_eq!(take(), 1);

    exec(&db, "SELECT * FROM t;", |_, _| {}).unwrap();
    assert_eq!(take(), 0);

    db.execute_batch("BEGIN TRANSACTION;\nINSERT INTO t VALUES (1, 'foo');\nROLLBACK;")
        .unwrap();
    assert_eq!(take(), 0);

    db.execute_batch(
        "BEGIN TRANSACTION;
        INSERT INTO t VALUES (1, 'foo');
        INSERT INTO t VALUES (2, 'bar');
        COMMIT;",
    )
    .unwrap();
    assert_eq!(take(), 1);
}

#[test]
fn can_change_commit_hook() {
    let db = db();
    db.execute_batch("CREATE TABLE t(i integer primary key, x);")
        .unwrap();
    let (a, b) = (Arc::new(Mutex::new(0)), Arc::new(Mutex::new(0)));

    counting_commit_hook(&db, &a);
    db.execute_batch("INSERT INTO t VALUES (1, 'foo');")
        .unwrap();
    assert_eq!((*a.lock().unwrap(), *b.lock().unwrap()), (1, 0));

    counting_commit_hook(&db, &b);
    db.execute_batch("INSERT INTO t VALUES (2, 'bar');")
        .unwrap();
    assert_eq!((*a.lock().unwrap(), *b.lock().unwrap()), (1, 1));

    db.commit_hook(None::<fn() -> bool>);
    db.execute_batch("INSERT INTO t VALUES (3, 'qux');")
        .unwrap();
    assert_eq!((*a.lock().unwrap(), *b.lock().unwrap()), (1, 1));
}

#[test]
fn can_rollback_based_on_return_value() {
    let db = db();
    db.execute_batch("CREATE TABLE t(i integer primary key, x);")
        .unwrap();

    db.commit_hook(Some(|| false));
    db.execute_batch("INSERT INTO t VALUES (1, 'foo');")
        .unwrap();

    db.commit_hook(Some(|| true));
    assert!(
        db.execute_batch("INSERT INTO t VALUES (2, 'bar');")
            .is_err()
    );

    let mut has_row = false;
    exec(&db, "SELECT * FROM t WHERE i = 2;", |_, _| has_row = true).unwrap();
    assert!(!has_row);
}

#[test]
fn does_not_overwrite_update_hook() {
    let db = db();
    db.execute_batch("CREATE TABLE t(i integer primary key, x);")
        .unwrap();
    let updates = Arc::new(Mutex::new(0));
    let seen = updates.clone();
    db.update_hook(Some(move |_: Action, _: &str, _: &str, _: i64| {
        *seen.lock().unwrap() += 1;
    }));
    let commits = Arc::new(Mutex::new(0));
    counting_commit_hook(&db, &commits);

    db.execute_batch("INSERT INTO t VALUES (1, 'foo');")
        .unwrap();
    assert_eq!(*updates.lock().unwrap(), 1);
    assert_eq!(*commits.lock().unwrap(), 1);
}
