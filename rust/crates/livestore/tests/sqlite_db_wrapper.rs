//! Port of `packages/@livestore/livestore/src/SqliteDbWrapper.test.ts`.

mod common;

use common::todomvc::make_todo_mvc;
use livestore::sqlite::{ExecuteOptions, TableSet};
use serde_json::json;

#[tokio::test]
async fn invalidates_cached_reads_after_changeset_and_savepoint_rollback() {
    let store = make_todo_mvc().await;
    let db = store.sqlite_db_wrapper();
    db.execute("CREATE TABLE rollback_cache_test (id INTEGER PRIMARY KEY, value INTEGER)")
        .unwrap();
    db.execute("INSERT INTO rollback_cache_test VALUES (1, 1)")
        .unwrap();
    let read = || {
        db.select("SELECT value FROM rollback_cache_test", &[])
            .unwrap()[0]["value"]
            .clone()
    };
    let ((), changeset) = db
        .with_changeset(|| db.execute("UPDATE rollback_cache_test SET value = 2"))
        .unwrap();
    assert_eq!(read(), json!(2));
    let changeset = changeset.expect("changeset recorded");
    db.make_changeset(changeset)
        .invert()
        .unwrap()
        .apply()
        .unwrap();
    assert_eq!(read(), json!(1));
    db.execute("SAVEPOINT cache_test").unwrap();
    db.execute("UPDATE rollback_cache_test SET value = 3")
        .unwrap();
    assert_eq!(read(), json!(3));
    db.execute("ROLLBACK TO SAVEPOINT cache_test").unwrap();
    db.execute("RELEASE SAVEPOINT cache_test").unwrap();
    assert_eq!(read(), json!(1));
}

/// The no-op tracer is a `tracing` dispatcher that records nothing.
#[tokio::test]
async fn works_with_the_open_telemetry_api_no_op_tracer() {
    let _guard = tracing::subscriber::set_default(tracing::subscriber::NoSubscriber::default());
    let probe = tracing::info_span!("verify-noop-tracer");
    assert!(probe.is_disabled());
    drop(probe);

    // Store creation exercises the configureSQLite execute path.
    let store = make_todo_mvc().await;
    let db = store.sqlite_db_wrapper();
    let duration_ms = db
        .cached_execute(
            "CREATE TABLE noop_timing_test (id INTEGER)",
            &[],
            ExecuteOptions {
                has_no_effects: true,
                write_tables: None,
            },
        )
        .unwrap();
    assert_eq!(
        db.select("SELECT 1 AS value", &[]).unwrap(),
        vec![json!({ "value": 1 }).as_object().unwrap().clone()]
    );
    assert!(db.debug_info().query_frame_count > 0);
    assert!(db.debug_info().query_frame_duration >= 0.0);
    assert!(duration_ms >= 0.0);
}

fn todos() -> TableSet {
    ["todos".to_string()].into()
}

#[tokio::test]
async fn should_return_the_correct_tables_used() {
    let store = make_todo_mvc().await;
    assert_eq!(
        store.sqlite_db_wrapper().tables_used("select * from todos"),
        todos()
    );
}

#[tokio::test]
async fn should_handle_delete_from_statement_without_where_clause() {
    let store = make_todo_mvc().await;
    assert_eq!(
        store.sqlite_db_wrapper().tables_used("DELETE FROM todos"),
        todos()
    );
}

#[tokio::test]
async fn should_handle_insert_with_on_conflict_clause() {
    let store = make_todo_mvc().await;
    let sql = "INSERT INTO todos (id, text, completed) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = ?";
    assert_eq!(store.sqlite_db_wrapper().tables_used(sql), todos());
}
