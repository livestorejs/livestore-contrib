//! Sync loop against a real sync-cf backend (wrangler). Run via `scripts/test-live.sh`.
//! Tests skip (pass) when no backend is reachable.

mod common;

use common::*;
use livestore_todomvc::{TodoCompleted, TodoCreated, TodoDeleted};

#[tokio::test]
async fn two_clients_converge_after_concurrent_offline_commits_and_restart() {
    let Some(url) = backend().await else { return };
    let store_id = unique("rust-converge");
    let (dir_a, dir_b) = (temp_dir("a"), temp_dir("b"));

    let a = start(
        open(&dir_a, "client-a").into_db(),
        "client-a",
        options(&url, &store_id),
    )
    .await;
    let b = start(
        open(&dir_b, "client-b").into_db(),
        "client-b",
        options(&url, &store_id),
    )
    .await;
    a.commit(TodoCreated {
        id: "t1".into(),
        text: "one".into(),
    })
    .unwrap();
    a.commit(TodoCreated {
        id: "t2".into(),
        text: "two".into(),
    })
    .unwrap();
    b.commit(TodoCreated {
        id: "t3".into(),
        text: "three".into(),
    })
    .unwrap();
    converge(&[&a, &b], 3).await;
    a.shutdown().await;
    b.shutdown().await;

    // Offline on both sides: committed straight into the on-disk leaders.
    let mut la = open(&dir_a, "client-a");
    la.commit(TodoCompleted { id: "t1".into() }).unwrap();
    la.commit(TodoCreated {
        id: "a-off".into(),
        text: "from a offline".into(),
    })
    .unwrap();
    let mut lb = open(&dir_b, "client-b");
    lb.commit(TodoDeleted {
        id: "t2".into(),
        deleted_at: date("2026-03-04T05:06:07.089Z"),
    })
    .unwrap();
    lb.commit(TodoCreated {
        id: "b-off".into(),
        text: "from b offline".into(),
    })
    .unwrap();
    lb.commit(TodoCompleted { id: "a-off".into() }).unwrap();
    drop((la, lb));

    // Restart from disk: boot pushes the pending events. A goes first so B deterministically rebases onto A.
    let a = start(
        open(&dir_a, "client-a").into_db(),
        "client-a",
        options(&url, &store_id),
    )
    .await;
    assert!(a.wait_synced(T).await);
    let b = start(
        open(&dir_b, "client-b").into_db(),
        "client-b",
        options(&url, &store_id),
    )
    .await;
    let rows = converge(&[&a, &b], 5).await;
    assert_eq!(a.info().upstream_head.global, 8);
    let completed: Vec<_> = rows
        .iter()
        .filter(|r| r["completed"] == 1)
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        completed,
        ["a-off", "t1"],
        "b rebased after a, so its completion of a-off applies"
    );
    assert!(
        rows.iter()
            .any(|r| r["id"] == "t2" && r["deletedAt"] == 1_772_600_767_089i64)
    );
}

#[tokio::test]
async fn restart_from_disk_pushes_pending() {
    let Some(url) = backend().await else { return };
    let store_id = unique("rust-restart");
    let dir = temp_dir("restart");

    let mut leader = open(&dir, "client-r");
    leader
        .commit(TodoCreated {
            id: "r1".into(),
            text: "before first connect".into(),
        })
        .unwrap();
    drop(leader);

    let store = start(
        open(&dir, "client-r").into_db(),
        "client-r",
        options(&url, &store_id),
    )
    .await;
    assert!(store.wait_synced(T).await, "{:?}", store.info());
    store
        .commit(TodoCreated {
            id: "r2".into(),
            text: "online".into(),
        })
        .unwrap();
    assert!(store.wait_synced(T).await);
    store.shutdown().await;

    let observer = start(
        livestore_sqlite::LeaderDb::open_in_memory(livestore_todomvc::schema()).unwrap(),
        "obs",
        options(&url, &store_id),
    )
    .await;
    let rows = converge(&[&observer], 2).await;
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["r1", "r2"]
    );

    // Boot from disk again: nothing pending, cursor resumes at the backend head.
    let store = start(
        open(&dir, "client-r").into_db(),
        "client-r",
        options(&url, &store_id),
    )
    .await;
    assert!(store.wait_synced(T).await);
    assert_eq!(store.info().upstream_head.global, 2);
}
