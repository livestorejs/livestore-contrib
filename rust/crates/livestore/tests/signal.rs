//! Port of `packages/@livestore/livestore/src/live-queries/signal.test.ts`.

mod common;

use common::todomvc::make_todo_mvc;
use livestore::{computed, signal};

#[tokio::test]
async fn should_be_able_to_create_a_signal() {
    let num = signal(0i64, Some("num$"));
    let duplicated = {
        let num = num.clone();
        computed(move |get| get.get(&num) * 2, Some("duplicated$"))
    };
    let store = make_todo_mvc().await;
    assert_eq!(store.query(&duplicated), 0);
    store.set_signal(&num, 1);
    assert_eq!(store.query(&duplicated), 2);
}

#[tokio::test]
async fn counter_example() {
    let count = signal(0i64, Some("count$"));
    let store = make_todo_mvc().await;
    let increment = || store.update_signal(&count, |prev| prev + 1);
    increment();
    increment();
    assert_eq!(store.query(&count), 2);
}
