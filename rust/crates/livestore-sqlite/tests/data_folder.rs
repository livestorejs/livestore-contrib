mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use livestore_schema::{Column, EventDef, Schema, Table};
use livestore_sqlite::{Error, LeaderDb, LocalLeader};
use serde::{Deserialize, Serialize};
use serde_json::json;

fn data_folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("livestore-folder-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open(dir: &Path) -> livestore_sqlite::Result<LeaderDb> {
    LeaderDb::open_folder(dir, common::schema())
}

#[derive(Serialize, Deserialize)]
struct TaskCreated {
    id: String,
}

fn tasks_schema(with_note: bool) -> Arc<Schema> {
    let mut tasks = Table::new("tasks").column(Column::text("id").primary_key());
    if with_note {
        tasks = tasks.column(Column::text("note").nullable());
    }
    let t = tasks.clone();
    Schema::builder()
        .table(tasks)
        .event(
            &EventDef::<TaskCreated>::synced("taskCreated"),
            move |a, _| Ok(t.insert([("id", a.id.into())])),
        )
        .build()
}

#[test]
fn a_second_leader_on_the_same_data_folder_fails_with_locked() {
    let dir = data_folder("second");
    let _first = open(&dir).unwrap();
    assert!(matches!(open(&dir), Err(Error::Locked(_))));
}

#[test]
fn closing_a_leader_releases_the_data_folder() {
    let dir = data_folder("release");
    drop(open(&dir).unwrap());
    assert!(open(&dir).is_ok());
}

#[test]
fn a_changed_table_rebuilds_the_state_from_the_eventlog() {
    let dir = data_folder("schema-change");
    let db = LeaderDb::open_folder(&dir, tasks_schema(false)).unwrap();
    let mut leader = LocalLeader::new(db, "client", "session").unwrap();
    leader.commit("taskCreated", json!({"id": "a"})).unwrap();
    drop(leader);

    let db = LeaderDb::open_folder(&dir, tasks_schema(true)).unwrap();
    assert_eq!(
        db.query("SELECT id, note FROM tasks").unwrap(),
        [json!({"id": "a", "note": null})
            .as_object()
            .unwrap()
            .clone()]
    );
}

#[test]
fn other_connections_cannot_read_the_files_while_the_leader_runs() {
    let dir = data_folder("exclusive");
    let leader = open(&dir).unwrap();
    let outside = rusqlite::Connection::open(dir.join("eventlog.db")).unwrap();
    outside.busy_timeout(std::time::Duration::ZERO).unwrap();
    let read = |conn: &rusqlite::Connection| {
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
    };
    assert!(read(&outside).is_err());
    drop(leader);
    assert!(read(&outside).is_ok());
}

#[cfg(unix)]
#[test]
fn only_the_owner_can_access_the_data_folder() {
    use std::os::unix::fs::PermissionsExt;
    let dir = data_folder("permissions");
    let _leader = open(&dir).unwrap();
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
}
