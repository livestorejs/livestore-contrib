//! Port of `packages/@livestore/livestore/src/store/store-commit.test.ts`.

mod common;

use std::panic::{AssertUnwindSafe, catch_unwind};

use common::todomvc::{TODOS, make_todo_mvc, todo, todo_completed, todo_created};
use livestore::{CommitOptions, EventInput};
use livestore_schema::query_builder::Direction;
use serde_json::json;

#[tokio::test]
async fn should_materialize_events_returned_by_the_commit_callback() {
    let store = make_todo_mvc().await;
    store
        .commit_fn(CommitOptions::default(), || {
            assert_eq!(store.query(&*TODOS), json!([]));
            vec![
                todo_created("1", "Make coffee", false),
                todo_created("2", "Buy groceries", false),
            ]
        })
        .unwrap();
    assert_eq!(
        store.query(&TODOS.query().order_by("id", Direction::Asc)),
        json!([
            todo("1", "Make coffee", false),
            todo("2", "Buy groceries", false)
        ])
    );
}

#[tokio::test]
async fn should_materialize_a_single_callback_event() {
    let store = make_todo_mvc().await;
    let batch = vec![todo_created("1", "Make coffee", false)];
    store.commit_fn(CommitOptions::default(), || batch).unwrap();
    assert_eq!(
        store.query(&*TODOS),
        json!([todo("1", "Make coffee", false)])
    );
}

#[tokio::test]
async fn should_accept_an_empty_callback() {
    let store = make_todo_mvc().await;
    store
        .commit_fn(CommitOptions::default(), Vec::<EventInput>::new)
        .unwrap();
    assert_eq!(store.query(&*TODOS), json!([]));
}

#[tokio::test]
async fn should_apply_no_events_when_the_callback_throws() {
    let store = make_todo_mvc().await;
    let thrown = catch_unwind(AssertUnwindSafe(|| {
        let _ = store.commit_fn(CommitOptions::default(), || -> Vec<EventInput> {
            panic!("Callback failed")
        });
    }))
    .expect_err("the callback's panic propagates");
    assert_eq!(thrown.downcast_ref::<&str>(), Some(&"Callback failed"));
    assert_eq!(store.query(&*TODOS), json!([]));
    store
        .commit([todo_created("1", "Make coffee", false)])
        .unwrap();
    assert_eq!(
        store.query(&*TODOS),
        json!([todo("1", "Make coffee", false)])
    );
}

#[tokio::test]
async fn should_commit_multiple_returned_event_types_in_order() {
    let store = make_todo_mvc().await;
    store
        .commit_fn(CommitOptions::default(), || {
            vec![todo_created("1", "Make coffee", false), todo_completed("1")]
        })
        .unwrap();
    assert_eq!(
        store.query(&*TODOS),
        json!([todo("1", "Make coffee", true)])
    );
}

#[tokio::test]
async fn should_accept_callback_options() {
    for options in [
        CommitOptions::default(),
        CommitOptions {
            label: Some("Create todo".into()),
            ..Default::default()
        },
    ] {
        let store = make_todo_mvc().await;
        store
            .commit_fn(options, || vec![todo_created("1", "Make coffee", false)])
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
