//! Port of `packages/@livestore/livestore/src/store/store-commit.test.ts`.

mod common;

use common::todomvc::{TODOS, make_todo_mvc, todo, todo_completed, todo_created};
use livestore::{CommitOptions, EventInput};
use serde_json::json;

#[tokio::test]
async fn should_commit_multiple_event_types_in_order() {
    let store = make_todo_mvc().await;
    store
        .commit((todo_created("1", "Make coffee", false), todo_completed("1")))
        .unwrap();
    assert_eq!(
        store.query(&*TODOS),
        json!([todo("1", "Make coffee", true)])
    );
}

#[tokio::test]
async fn should_accept_commit_options() {
    for options in [
        CommitOptions::default(),
        CommitOptions {
            label: Some("Create todo".into()),
            ..Default::default()
        },
    ] {
        let store = make_todo_mvc().await;
        store
            .commit_with(options, todo_created("1", "Make coffee", false))
            .unwrap();
        assert_eq!(
            store.query(&*TODOS),
            json!([todo("1", "Make coffee", false)])
        );
    }
}

#[tokio::test]
async fn should_still_accept_direct_events_with_options_and_no_events() {
    let store = make_todo_mvc().await;
    store.commit(Vec::<EventInput>::new()).unwrap();
    store
        .commit_with(
            CommitOptions {
                label: Some("Empty commit".into()),
                ..Default::default()
            },
            Vec::<EventInput>::new(),
        )
        .unwrap();
    store
        .commit_with(
            CommitOptions {
                label: Some("Create and complete".into()),
                ..Default::default()
            },
            [todo_created("1", "Make coffee", false), todo_completed("1")],
        )
        .unwrap();
    assert_eq!(
        store.query(&*TODOS),
        json!([todo("1", "Make coffee", true)])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_commit_from_a_thread_without_tokio_returns_the_error() {
    let store = make_todo_mvc().await;
    store.close().await;
    let result = std::thread::spawn(move || {
        store
            .commit(vec![todo_created("1", "Make coffee", false)])
            .is_err()
    })
    .join();
    assert_eq!(result.ok(), Some(true));
}
