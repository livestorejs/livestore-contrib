mod common;

use std::path::PathBuf;

use livestore_sqlite::{Error, LeaderDb};

fn data_folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("livestore-lock-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open(dir: &std::path::Path) -> livestore_sqlite::Result<LeaderDb> {
    LeaderDb::open(
        dir.join("state.db"),
        dir.join("eventlog.db"),
        common::schema(),
    )
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
