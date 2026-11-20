use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use livestore_core::GlobalEvent;
use livestore_sync::testing::{MockSyncBackend, MockSyncBackendOptions};
use livestore_sync::{PullCursor, PullOptions, PullResItem, SyncBackend, network_status};
use serde_json::json;

const T: Duration = Duration::from_secs(5);

#[tokio::test]
async fn broadcasts_live_events_to_every_backend_connection() {
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        start_connected: true,
        ..Default::default()
    });
    let (a, b) = (
        mock.make_sync_backend().await,
        mock.make_sync_backend().await,
    );
    let (pull_a, pull_b) = (
        tokio::spawn(next_batch(a, None)),
        tokio::spawn(next_batch(b, None)),
    );
    let event = make_event(1);
    mock.advance(vec![event.clone()]).await;
    assert_eq!(events(pull_a.await.unwrap()), std::slice::from_ref(&event));
    assert_eq!(events(pull_b.await.unwrap()), [event]);
}

#[tokio::test]
async fn seeds_a_new_backend_connection_with_existing_live_events() {
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        start_connected: true,
        ..Default::default()
    });
    let event = make_event(1);
    mock.advance(vec![event.clone()]).await;
    let backend = mock.make_sync_backend().await;
    assert_eq!(events(next_batch(backend, None).await), [event]);
}

#[tokio::test]
async fn filters_seeded_live_events_against_the_requested_cursor() {
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        start_connected: true,
        ..Default::default()
    });
    let (existing, next) = (make_event(1), make_event(2));
    mock.advance(vec![existing.clone()]).await;
    let backend = mock.make_sync_backend().await;
    let pull = tokio::spawn(next_batch(
        backend,
        Some(PullCursor {
            event_sequence_number: existing.seq_num,
            metadata: None,
        }),
    ));
    mock.advance(vec![next.clone()]).await;
    assert_eq!(events(pull.await.unwrap()), [next]);
}

#[tokio::test]
async fn tracks_sync_backend_connectivity_and_devtools_latch_state() {
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        start_connected: false,
        ..Default::default()
    });
    let backend = mock.make_sync_backend().await;
    let mut status = network_status(&backend);
    let initial = *status.borrow();
    assert!(!initial.is_connected);
    mock.connect();
    let online = *tokio::time::timeout(T, status.wait_for(|s| s.is_connected))
        .await
        .unwrap()
        .unwrap();
    assert!(online.is_connected);
    assert!(online.timestamp_ms >= initial.timestamp_ms);
}

/// `pull(cursor, { live: true }).pipe(Stream.filter(nonEmpty), Stream.runFirstUnsafe)`.
async fn next_batch(backend: Arc<dyn SyncBackend>, cursor: Option<PullCursor>) -> PullResItem {
    let mut pull = backend
        .pull(cursor, PullOptions { live: true })
        .filter(|i| futures::future::ready(i.as_ref().is_ok_and(|i| !i.batch.is_empty())));
    tokio::time::timeout(T, pull.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

fn events(item: PullResItem) -> Vec<GlobalEvent> {
    item.batch.into_iter().map(|i| i.event_encoded).collect()
}

fn make_event(seq_num: i64) -> GlobalEvent {
    GlobalEvent {
        name: "v1.TestEvent".into(),
        args: json!({"id": format!("event-{seq_num}")}),
        seq_num,
        parent_seq_num: seq_num - 1,
        client_id: "client-a".into(),
        session_id: "session-a".into(),
    }
}
