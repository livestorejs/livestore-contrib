mod common;

use livestore_core::{Event, SeqNum};
use livestore_sqlite::{Error, LeaderDb, PullCursorInfo, PulledEvent, UpstreamCommit, eventlog};
use serde_json::{Value, json};

use common::select;

#[test]
fn commits_local_events_without_mutating_the_plan() {
    let db = setup();
    let event = todo(1, 0, SeqNum::ROOT, "local", "Local");
    let before = event.clone();

    let receipt = db.persist_local(std::slice::from_ref(&event)).unwrap();

    assert_eq!(
        rows(&db, true, "SELECT id, text FROM todos"),
        vec![json!({"id": "local", "text": "Local"})]
    );
    assert_eq!(
        rows(&db, false, "SELECT name FROM eventlog"),
        vec![json!({"name": "todoCreated"})]
    );
    assert_eq!(db.state_head().unwrap(), event.seq_num);
    assert_eq!(event, before);
    assert_eq!(receipt.persisted_events, vec![event]);
}

#[test]
fn rolls_back_both_databases_when_an_upstream_batch_fails_during_materialization() {
    let db = setup();
    let first = todo(1, 0, SeqNum::ROOT, "duplicate", "First");
    let duplicate = todo(2, 0, first.seq_num, "duplicate", "Second");

    let error = db
        .persist_upstream(&UpstreamCommit {
            pulled_events: &[pulled(&first, None), pulled(&duplicate, None)],
            events: &[first.clone(), duplicate.clone()],
            rollback_events: &[],
            confirmed_events: &[],
            backend_head: duplicate.seq_num,
        })
        .unwrap_err();

    assert!(matches!(error, Error::Materialize(_)), "{error:?}");
    assert_eq!(snapshot(&db), empty_snapshot());
    assert_eq!(db.state_head().unwrap(), SeqNum::ROOT);
}

#[test]
fn rolls_back_a_local_batch_in_both_databases_when_it_fails_partway() {
    let db = setup();
    let first = todo(1, 0, SeqNum::ROOT, "duplicate", "First");
    let duplicate = todo(2, 0, first.seq_num, "duplicate", "Second");

    let error = db.persist_local(&[first, duplicate]).unwrap_err();

    assert!(matches!(error, Error::Materialize(_)), "{error:?}");
    assert_eq!(snapshot(&db), empty_snapshot());
    assert_eq!(db.state_head().unwrap(), SeqNum::ROOT);
}

#[test]
fn restores_rollback_eventlog_journal_and_heads_when_an_upstream_rebase_fails_at_its_last_write() {
    let db = setup();
    let pending: Vec<Event> = (0..101)
        .map(|i| {
            todo(
                i + 1,
                0,
                SeqNum::new(i, 0, 0),
                &format!("pending-{}", i + 1),
                "Pending",
            )
        })
        .collect();
    db.persist_local(&pending).unwrap();
    let before = snapshot(&db);
    let head_before = db.state_head().unwrap();
    assert_eq!(before["journal"].as_array().unwrap().len(), pending.len());

    db.eventlog_conn()
        .execute_batch(
            "CREATE TRIGGER fail_backend_head BEFORE UPDATE ON __livestore_sync_status BEGIN SELECT RAISE(ABORT, 'backend head write failed'); END",
        )
        .unwrap();
    let replacement = todo(1, 1, SeqNum::ROOT, "replacement", "Replacement");

    let error = db
        .persist_upstream(&UpstreamCommit {
            pulled_events: &[pulled(&replacement, None)],
            events: std::slice::from_ref(&replacement),
            rollback_events: &pending,
            confirmed_events: &[],
            backend_head: replacement.seq_num,
        })
        .unwrap_err();

    assert!(matches!(error, Error::Materialize(_)), "{error:?}");
    assert_eq!(snapshot(&db), before);
    assert_eq!(db.state_head().unwrap(), head_before);
}

#[test]
fn replaces_rolled_back_history_and_advances_the_backend_head_in_one_upstream_commit() {
    let db = setup();
    let original = todo(1, 0, SeqNum::ROOT, "original", "Original");
    db.persist_local(std::slice::from_ref(&original)).unwrap();
    let replacement = todo(1, 1, SeqNum::ROOT, "replacement", "Replacement");

    let receipt = db
        .persist_upstream(&UpstreamCommit {
            pulled_events: &[pulled(&replacement, Some(json!({"cursor": "upstream-1"})))],
            events: std::slice::from_ref(&replacement),
            rollback_events: std::slice::from_ref(&original),
            confirmed_events: &[],
            backend_head: replacement.seq_num,
        })
        .unwrap();

    assert_eq!(
        rows(&db, true, "SELECT id, text FROM todos"),
        vec![json!({"id": "replacement", "text": "Replacement"})]
    );
    assert_eq!(
        rows(&db, false, "SELECT seqNumRebaseGeneration FROM eventlog"),
        vec![json!({"seqNumRebaseGeneration": 1})]
    );
    assert_eq!(eventlog::backend_head(db.eventlog_conn()).unwrap(), 1);
    assert_eq!(db.state_head().unwrap(), replacement.seq_num);
    assert_eq!(
        rows(
            &db,
            true,
            "SELECT * FROM __livestore_materialization_journal"
        ),
        Vec::<serde_json::Value>::new()
    );
    assert_eq!(receipt.rolled_back_event_nums, vec![original.seq_num]);
}

#[test]
fn persists_confirmation_metadata_with_the_matching_backend_head() {
    let db = setup();
    let pending = todo(1, 2, SeqNum::ROOT, "confirmed", "Confirmed");
    db.persist_local(std::slice::from_ref(&pending)).unwrap();
    let upstream = todo(1, 0, SeqNum::ROOT, "confirmed", "Confirmed");

    db.persist_upstream(&UpstreamCommit {
        pulled_events: &[pulled(&upstream, Some(json!({"cursor": "confirmed-1"})))],
        events: &[],
        rollback_events: &[],
        confirmed_events: std::slice::from_ref(&pending),
        backend_head: upstream.seq_num,
    })
    .unwrap();

    assert_eq!(
        db.cursor_info(upstream.seq_num.global).unwrap(),
        Some(PullCursorInfo {
            event_sequence_number: 1,
            metadata: Some(json!({"cursor": "confirmed-1"}))
        })
    );
    assert_eq!(eventlog::backend_head(db.eventlog_conn()).unwrap(), 1);
    assert_eq!(
        rows(
            &db,
            true,
            "SELECT * FROM __livestore_materialization_journal"
        ),
        Vec::<serde_json::Value>::new()
    );
}

fn setup() -> LeaderDb {
    common::leader_db(common::schema())
}

fn todo(global: i64, rebase_generation: i64, parent: SeqNum, id: &str, text: &str) -> Event {
    common::event(
        "todoCreated",
        json!({"id": id, "text": text}),
        SeqNum::new(global, 0, rebase_generation),
        parent,
        "test-client",
        "test-session",
    )
}

fn pulled(event: &Event, sync_metadata: Option<Value>) -> PulledEvent {
    PulledEvent {
        event: event.clone(),
        sync_metadata,
    }
}

fn rows(db: &LeaderDb, state: bool, sql: &str) -> Vec<Value> {
    let conn = if state {
        db.state_conn()
    } else {
        db.eventlog_conn()
    };
    select(conn, sql).into_iter().map(Value::Object).collect()
}

fn snapshot(db: &LeaderDb) -> Value {
    json!({
        "todos": rows(db, true, "SELECT * FROM todos"),
        "journal": rows(db, true, "SELECT * FROM __livestore_materialization_journal"),
        "eventlog": rows(db, false, "SELECT * FROM eventlog"),
        "backendHead": eventlog::backend_head(db.eventlog_conn()).unwrap(),
    })
}

fn empty_snapshot() -> Value {
    json!({"todos": [], "journal": [], "eventlog": [], "backendHead": 0})
}
