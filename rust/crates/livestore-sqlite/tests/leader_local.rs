use livestore_core::{Event, SeqNum};
use livestore_sqlite::{Error, LocalLeader, PulledEvent, state};
use livestore_todomvc::TodoCreated;
use serde_json::json;

#[test]
fn restart_restores_pending_and_skips_rebuild_when_state_is_complete() {
    let dir = temp_dir("restart");
    let open = || {
        LocalLeader::open(
            dir.join("state.db"),
            dir.join("eventlog.db"),
            livestore_todomvc::schema(),
            "c",
            "s",
        )
        .unwrap()
    };

    let mut leader = open();
    leader
        .commit(TodoCreated {
            id: "a".into(),
            text: "A".into(),
        })
        .unwrap();
    leader
        .commit(livestore_todomvc::ui_state().set(json!({"filter": "active"}), Some("s")))
        .unwrap();
    leader
        .apply_upstream(&[remote(1, "v1.TodoCreated", json!({"id": "r", "text": "R"}))])
        .unwrap();
    let before = leader.sync_state().clone();
    drop(leader);

    let leader = open();
    assert_eq!(leader.sync_state(), &before);
    assert_eq!(
        leader
            .pending_to_push()
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        ["v1.TodoCreated"]
    );
    assert_eq!(
        leader.db().cursor_info(1).unwrap(),
        Some(livestore_sqlite::PullCursorInfo {
            event_sequence_number: 1,
            metadata: None
        })
    );
    assert_eq!(count(&leader, "todos"), 2);

    // Missing rebuild marker = incomplete state: boot rebuilds from the eventlog.
    leader
        .db()
        .state_conn()
        .execute("DELETE FROM __livestore_rebuild", [])
        .unwrap();
    leader
        .db()
        .state_conn()
        .execute("DELETE FROM todos", [])
        .unwrap();
    drop(leader);
    let leader = open();
    assert_eq!(count(&leader, "todos"), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rollback_fails_without_journal_record() {
    let leader = LocalLeader::open_in_memory(livestore_todomvc::schema(), "c", "s").unwrap();
    let err = state::rollback(leader.db().state_conn(), &[SeqNum::new(1, 0, 0)]).unwrap_err();
    assert!(matches!(err, Error::MaterializationJournal(_)), "{err:?}");
}

#[test]
fn backend_id_round_trips() {
    let leader = LocalLeader::open_in_memory(livestore_todomvc::schema(), "c", "s").unwrap();
    assert_eq!(leader.db().backend_id().unwrap(), None);
    leader.db().set_backend_id("it's-1").unwrap();
    assert_eq!(leader.db().backend_id().unwrap().as_deref(), Some("it's-1"));
}

fn remote(seq: i64, name: &str, args: serde_json::Value) -> PulledEvent {
    PulledEvent {
        event: Event {
            name: name.into(),
            args,
            seq_num: SeqNum::new(seq, 0, 0),
            parent_seq_num: SeqNum::new(seq - 1, 0, 0),
            client_id: "other".into(),
            session_id: "other".into(),
        },
        sync_metadata: None,
    }
}

fn count(leader: &LocalLeader, table: &str) -> i64 {
    leader
        .db()
        .state_conn()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("livestore-leader-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
