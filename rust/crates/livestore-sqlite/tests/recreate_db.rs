mod common;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use livestore_core::SeqNum;
use livestore_schema::{Column, EventDef, MaterializeError, Schema, Table};
use livestore_sqlite::state::{MigrationHook, MigrationHooks, RebuildOptions};
use livestore_sqlite::{BootOptions, LeaderDb, eventlog, state};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use common::select;

#[test]
fn rebuilds_surviving_partial_state_after_init_failure_on_common_leader_boot_1605() {
    rebuilds_surviving_partial_state_after("init");
}

#[test]
fn rebuilds_surviving_partial_state_after_pre_failure_on_common_leader_boot_1605() {
    rebuilds_surviving_partial_state_after("pre");
}

#[test]
fn rebuilds_surviving_partial_state_after_replay_failure_on_common_leader_boot_1605() {
    rebuilds_surviving_partial_state_after("replay");
}

#[test]
fn rebuilds_surviving_partial_state_after_replay_after_batch_failure_on_common_leader_boot_1605() {
    rebuilds_surviving_partial_state_after("replay-after-batch");
}

#[test]
fn rebuilds_surviving_partial_state_after_post_failure_on_common_leader_boot_1605() {
    rebuilds_surviving_partial_state_after("post");
}

#[test]
fn rebuilds_surviving_partial_state_after_interrupt_failure_on_common_leader_boot_1605() {
    rebuilds_surviving_partial_state_after("interrupt");
}

#[test]
fn publishes_rebuild_completion_only_after_an_async_post_hook_finishes_1605() {
    let state_db = Connection::open_in_memory().unwrap();
    let eventlog_db = Connection::open_in_memory().unwrap();
    eventlog::init(&eventlog_db).unwrap();
    let marker_during_post = Arc::new(Mutex::new(None));
    let seen = marker_during_post.clone();
    let post: MigrationHook = Arc::new(move |db| {
        *seen.lock().unwrap() = Some(rows(db, "SELECT * FROM __livestore_rebuild"));
        Ok(())
    });
    let options = RebuildOptions {
        hooks: MigrationHooks {
            post: Some(post),
            ..Default::default()
        },
        ..Default::default()
    };

    state::rebuild(
        &state_db,
        &eventlog_db,
        &Schema::builder().build(),
        &options,
    )
    .unwrap();

    assert_eq!(*marker_during_post.lock().unwrap(), Some(vec![]));
    assert_eq!(
        rows(&state_db, "SELECT * FROM __livestore_rebuild"),
        vec![json!({"id": 1})]
    );
}

fn rebuilds_surviving_partial_state_after(failure: &'static str) {
    let dir = std::env::temp_dir().join(format!(
        "livestore-recreate-db-{failure}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let event_ids: Vec<String> = (1..=5).map(|i| format!("todo-{i}")).collect();
    {
        let eventlog_db = Connection::open(dir.join("eventlog.db")).unwrap();
        eventlog::init(&eventlog_db).unwrap();
        for (i, id) in event_ids.iter().enumerate() {
            let global = i as i64 + 1;
            let event = common::event(
                "created",
                json!({"id": id}),
                SeqNum::new(global, 0, 0),
                SeqNum::new(global - 1, 0, 0),
                "test",
                "static-session-id",
            );
            eventlog::insert(&eventlog_db, &event, 0, None).unwrap();
        }
    }
    let before = read_eventlog(&dir);

    let should_fail = Arc::new(AtomicBool::new(true));
    let attempted_events = Arc::new(Mutex::new(Vec::<String>::new()));
    let attempted_hooks = Arc::new(Mutex::new(Vec::<String>::new()));
    let schema = make_schema(failure, should_fail.clone(), attempted_events.clone());
    let hooks = make_hooks(failure, should_fail.clone(), attempted_hooks.clone());
    let batch_size = if failure == "replay-after-batch" {
        2
    } else {
        state::STATE_REBUILD_BATCH_SIZE_DEFAULT
    };
    let boot = || -> Result<Value, livestore_sqlite::Error> {
        let options = BootOptions {
            rebuild: RebuildOptions {
                hooks: hooks.clone(),
                batch_size,
            },
            import_snapshot: None,
        };
        let db = LeaderDb::boot_with(
            Connection::open(dir.join("state.db")).unwrap(),
            Connection::open(dir.join("eventlog.db")).unwrap(),
            schema.clone(),
            options,
        )?;
        Ok(json!({
            "todos": rows(db.state_conn(), "SELECT * FROM rebuild_todos ORDER BY id ASC"),
            "pending": db.initial_sync_state()?.pending.len(),
            "marker": rows(db.state_conn(), "SELECT * FROM __livestore_rebuild"),
        }))
    };

    if failure == "interrupt" {
        assert!(catch_unwind(AssertUnwindSafe(boot)).is_err());
    } else {
        assert!(boot().is_err(), "{failure}");
    }
    {
        let partial = Connection::open(dir.join("state.db")).unwrap();
        assert!(
            !rows(&partial, "SELECT * FROM scratch").is_empty(),
            "{failure}"
        );
        if failure != "init" {
            assert!(
                rows(&partial, "SELECT * FROM __livestore_rebuild").is_empty(),
                "{failure}"
            );
        }
        if failure == "replay" || failure == "replay-after-batch" {
            let committed = if failure == "replay" { 0 } else { 2 };
            assert_eq!(
                rows(&partial, "SELECT * FROM rebuild_todos").len(),
                committed,
                "{failure}"
            );
            assert_eq!(
                rows(
                    &partial,
                    "SELECT * FROM __livestore_materialization_journal"
                )
                .len(),
                committed,
                "{failure}"
            );
            assert_eq!(
                state::head(&partial).unwrap().global,
                committed as i64,
                "{failure}"
            );
        }
        if failure == "post" || failure == "interrupt" {
            assert_eq!(
                rows(&partial, "SELECT * FROM rebuild_todos").len(),
                5,
                "{failure}"
            );
        }
    }
    assert_eq!(read_eventlog(&dir), before);

    should_fail.store(false, Ordering::SeqCst);
    attempted_events.lock().unwrap().clear();
    attempted_hooks.lock().unwrap().clear();
    let recovered = boot().unwrap();
    let mut expected_todos = vec![json!({"id": "post-hook"})];
    expected_todos.extend(event_ids.iter().map(|id| json!({"id": id})));
    assert_eq!(
        recovered,
        json!({"todos": expected_todos, "pending": event_ids.len(), "marker": [{"id": 1}]}),
        "{failure}"
    );
    assert_eq!(*attempted_events.lock().unwrap(), event_ids);
    assert_eq!(*attempted_hooks.lock().unwrap(), ["init", "pre", "post"]);
    assert_eq!(read_eventlog(&dir), before);

    should_fail.store(true, Ordering::SeqCst);
    attempted_events.lock().unwrap().clear();
    attempted_hooks.lock().unwrap().clear();
    assert_eq!(boot().unwrap(), recovered);
    assert!(attempted_events.lock().unwrap().is_empty());
    assert!(attempted_hooks.lock().unwrap().is_empty());
    assert_eq!(read_eventlog(&dir), before);
    std::fs::remove_dir_all(dir).unwrap();
}

#[derive(Serialize, Deserialize)]
struct Created {
    id: String,
}

fn todos() -> Table {
    Table::new("rebuild_todos").column(Column::text("id").primary_key())
}

fn make_schema(
    failure: &'static str,
    should_fail: Arc<AtomicBool>,
    attempted: Arc<Mutex<Vec<String>>>,
) -> Arc<Schema> {
    let t = todos();
    Schema::builder()
        .table(todos())
        .event(&EventDef::<Created>::synced("created"), move |a, _| {
            attempted.lock().unwrap().push(a.id.clone());
            if should_fail.load(Ordering::SeqCst)
                && (failure == "replay" || failure == "replay-after-batch")
                && a.id == "todo-3"
            {
                return Err(MaterializeError::Other("Injected replay failure".into()));
            }
            Ok(t.insert([("id", a.id.into())]))
        })
        .build()
}

fn make_hooks(
    failure: &'static str,
    should_fail: Arc<AtomicBool>,
    attempted: Arc<Mutex<Vec<String>>>,
) -> MigrationHooks {
    let fail = should_fail.clone();
    let fail_hook = move |stage: &str| -> Result<(), String> {
        attempted.lock().unwrap().push(stage.into());
        if fail.load(Ordering::SeqCst) && failure == stage {
            Err(format!("Injected {stage} failure"))
        } else {
            Ok(())
        }
    };
    let (f1, f2, f3) = (fail_hook.clone(), fail_hook.clone(), fail_hook);
    MigrationHooks {
        init: Some(Arc::new(move |db: &Connection| {
            exec(
                db,
                "CREATE TABLE scratch (id INTEGER PRIMARY KEY); INSERT INTO scratch VALUES (1)",
            )?;
            f1("init")
        })),
        pre: Some(Arc::new(move |db: &Connection| {
            exec(db, "INSERT INTO scratch VALUES (2)")?;
            f2("pre")
        })),
        post: Some(Arc::new(move |db: &Connection| {
            exec(db, "INSERT INTO scratch VALUES (3)")?;
            f3("post")?;
            if should_fail.load(Ordering::SeqCst) && failure == "interrupt" {
                panic!("interrupted inside the post hook");
            }
            exec(db, "INSERT INTO rebuild_todos (id) VALUES ('post-hook')")
        })),
    }
}

fn exec(db: &Connection, sql: &str) -> Result<(), String> {
    db.execute_batch(sql).map_err(|e| e.to_string())
}

fn read_eventlog(dir: &Path) -> Value {
    let db = Connection::open(dir.join("eventlog.db")).unwrap();
    json!({ "events": rows(&db, "SELECT * FROM eventlog"), "sync": rows(&db, "SELECT * FROM __livestore_sync_status") })
}

fn rows(db: &Connection, sql: &str) -> Vec<Value> {
    select(db, sql).into_iter().map(Value::Object).collect()
}
