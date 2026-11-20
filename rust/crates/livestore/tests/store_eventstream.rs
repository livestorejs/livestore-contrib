//! Port of `packages/@livestore/livestore/src/store/store-eventstream.test.ts`.

mod common;

use std::time::Duration;

use common::todomvc::{schema, todo_created};
use futures::StreamExt;
use livestore::{
    EventsOptions, InMemoryAdapter, StoreOptions, create_store, make_shutdown_deferred,
};
use livestore_sync::testing::{MockSyncBackend, MockSyncBackendOptions};
use livestore_sync::{OnSyncError, SyncOptions};

#[tokio::test]
async fn should_resume_when_reconnected_to_sync_backend() {
    let backend = MockSyncBackend::new(MockSyncBackendOptions::default());
    let adapter = InMemoryAdapter {
        sync: Some(SyncOptions {
            backend: Some(backend.constructor()),
            on_sync_error: OnSyncError::Shutdown,
            ..SyncOptions::default()
        }),
        ..InMemoryAdapter::default()
    };
    let mut options = StoreOptions::new(schema(), adapter.build(), "eventstream-test");
    options.shutdown_deferred = Some(make_shutdown_deferred());
    let store = create_store(options).await.unwrap();
    backend.connect();

    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    let mut stream = store.events_stream(EventsOptions::default());
    let drain = tokio::spawn(async move {
        while let Some(event) = stream.next().await {
            if tx.send(event.expect("event")).is_err() {
                break;
            }
        }
    });

    store.commit([todo_created("1", "t1", false)]).unwrap();
    let initial = events.recv().await.unwrap();
    assert_eq!(initial.name, "todo.created");
    assert_eq!(initial.args["id"], "1");

    backend.disconnect();
    store.commit([todo_created("2", "t2", false)]).unwrap();
    let while_disconnected = tokio::time::timeout(Duration::from_millis(250), events.recv()).await;
    assert!(while_disconnected.is_err(), "no event while disconnected");

    backend.connect();
    let resumed = events.recv().await.unwrap();
    assert_eq!(resumed.name, "todo.created");
    assert_eq!(resumed.args["id"], "2");
    drain.abort();
}
