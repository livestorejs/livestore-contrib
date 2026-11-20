//! Port of `tests/sync-provider/src/sync-provider.test.ts`: the backend contract, run live against
//! wrangler for every selected provider (`common::providers`). Run via `scripts/test-live.sh`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::providers::{Provider, selected_providers};
use common::*;
use futures::StreamExt;
use livestore_sync::testing::{ClientIdentity, EventFactory, Sequence};
use livestore_sync::{PageInfo, PullCursor, PullOptions, PullResItem, PushError, SyncBackend};
use livestore_sync_cf::transport::BackendError;
use serde_json::json;
use tokio::time::timeout;

const LIVE: PullOptions = PullOptions { live: true };
const ONCE: PullOptions = PullOptions { live: false };

fn factory() -> EventFactory {
    EventFactory::new(ClientIdentity::with_session("test-client", "test-session"))
}

fn todo(f: &mut EventFactory, id: &str, text: &str) -> livestore_core::GlobalEvent {
    f.next(
        "todoCreated",
        json!({"id": id, "text": text, "completed": false}),
    )
}

/// `describe.each(providerLayers)`: runs `body` once per selected provider with a fresh backend.
async fn each<F, Fut>(test: &str, body: F)
where
    F: Fn(&'static Provider, Arc<dyn SyncBackend>) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(url) = backend().await else { return };
    for p in selected_providers() {
        let backend = make_backend(
            &(p.make)(&url),
            &unique(&format!("test-store-{}-{test}", p.key)),
            None,
        )
        .await;
        eprintln!("{} sync provider: {test}", p.name);
        timeout(Duration::from_secs(360), body(p, backend))
            .await
            .expect("test timed out");
    }
}

async fn collect(b: &Arc<dyn SyncBackend>, cursor: Option<PullCursor>) -> Vec<PullResItem> {
    b.pull(cursor, ONCE).map(Result::unwrap).collect().await
}

async fn first_non_empty(b: Arc<dyn SyncBackend>) -> PullResItem {
    b.pull(None, LIVE)
        .map(Result::unwrap)
        .filter(|r| futures::future::ready(!r.batch.is_empty()))
        .next()
        .await
        .unwrap()
}

#[tokio::test]
async fn can_create_sync_backend() {
    each("can-create", |_, b| async move {
        assert!(b.supports().pull_live);
        assert!(!b.metadata().name.is_empty());
    })
    .await;
}

#[tokio::test]
async fn can_ping_sync_backend() {
    each("can-ping", |_, b| async move { b.ping().await.unwrap() }).await;
}

#[tokio::test]
async fn can_connect_to_sync_backend() {
    each("can-connect", |_, b| async move {
        assert!(!*b.is_connected().borrow());
        b.connect().await.unwrap();
        assert!(*b.is_connected().borrow());
    })
    .await;
}

#[tokio::test]
async fn can_pull_events_from_sync_backend() {
    each("can-pull", |_, b| async move {
        let first = b.pull(None, ONCE).next().await.unwrap().unwrap();
        assert_eq!(first, PullResItem::empty());
    })
    .await;
}

#[tokio::test]
async fn live_pull_needs_to_return_a_no_more_page_info() {
    each("no-more", |_, b| async move {
        let first = b.pull(None, LIVE).next().await.unwrap().unwrap();
        assert_eq!(first.page_info, PageInfo::NoMore);
    })
    .await;
}

#[tokio::test]
async fn live_pull_survives_idle_and_receives_later_event() {
    each("idle", |_, b| async move {
        let mut f = factory();
        let fiber = tokio::spawn(first_non_empty(b.clone()));
        tokio::time::sleep(Duration::from_millis(800)).await;
        b.push(vec![todo(&mut f, "idle-1", "Late event")])
            .await
            .unwrap();
        assert_eq!(fiber.await.unwrap().batch.len(), 1);
    })
    .await;
}

#[tokio::test]
async fn can_pull_with_cursor() {
    each("cursor", |_, b| async move {
        b.push(vec![todo(&mut factory(), "1", "Test event 1.")])
            .await
            .unwrap();
        let first = b
            .pull(None, ONCE)
            .map(Result::unwrap)
            .filter(|r| futures::future::ready(!r.batch.is_empty()))
            .next()
            .await
            .unwrap();
        assert_eq!(first.batch.len(), 1);
        let last = first.batch.last().unwrap();
        let cursor = PullCursor {
            event_sequence_number: last.event_encoded.seq_num,
            metadata: last.metadata.clone(),
        };
        let second = b.pull(Some(cursor), ONCE).next().await.unwrap().unwrap();
        assert_eq!(second, PullResItem::empty());
    })
    .await;
}

#[tokio::test]
async fn serialized_admission_serializes_concurrent_pushes_that_share_the_same_parent() {
    each("serialized", |p, b| async move {
        if p.key != "cf-ws-do" {
            return;
        }
        let contenders: Vec<_> = (0..8)
            .map(|i| {
                let mut f = EventFactory::starting_at(
                    ClientIdentity::with_session(
                        &format!("contender-{i}"),
                        &format!("session-{i}"),
                    ),
                    1,
                    Sequence::Root,
                );
                todo(&mut f, &format!("contender-{i}"), &format!("Contender {i}"))
            })
            .collect();
        let barrier = Arc::new(tokio::sync::Barrier::new(contenders.len()));
        let tasks: Vec<_> = contenders
            .into_iter()
            .map(|event| {
                let (b, barrier) = (b.clone(), barrier.clone());
                tokio::spawn(async move {
                    barrier.wait().await;
                    b.push(vec![event]).await
                })
            })
            .collect();
        let results = futures::future::join_all(tasks)
            .await
            .into_iter()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|r| r.is_err()).count(), 7);
        assert!(
            results
                .iter()
                .filter_map(|r| r.as_ref().err())
                .all(|e| matches!(e, PushError::ServerAhead(_))),
            "{results:?}"
        );
        let pulled = collect(&b, None).await;
        assert_eq!(pulled.iter().map(|r| r.batch.len()).sum::<usize>(), 1);
    })
    .await;
}

#[tokio::test]
async fn large_batches_handling_streams_batch_variations_over_provider_payload_limits() {
    // `Vitest.live.prop(..., { arbitrary: { runs: 1 } })`: one scenario drawn from the schema bounds.
    let seed = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let pick = |i: u64, lo: usize, hi: usize| lo + ((seed >> (i * 8)) as usize % (hi - lo + 1));
    let scenario = if seed >> 63 == 0 {
        // fewLarge: eventCount 20..=28, payloadSize 70k..=110k, pushBatchSize 6..=12, total ≥ 1 MB.
        let payload = pick(1, 70_000, 110_000);
        (
            "fewLarge",
            pick(2, 20, 28).max(1_000_000usize.div_ceil(payload)),
            payload,
            pick(3, 6, 12),
        )
    } else {
        let payload = pick(1, 900, 1_200);
        (
            "manySmall",
            pick(2, 1_200, 1_600).max(1_000_000usize.div_ceil(payload)),
            payload,
            pick(3, 30, 160),
        )
    };
    eprintln!("scenario {scenario:?}");
    batch_scenario("large-batches", scenario).await;
}

#[tokio::test]
async fn large_batches_handling_streams_dozens_of_extremely_large_batches() {
    batch_scenario("dozens-large", ("fewLarge", 60, 120_000, 6)).await;
}

#[tokio::test]
async fn large_batches_handling_streams_thousands_of_small_batches() {
    batch_scenario("thousands-small", ("manySmall", 1_800, 1_024, 90)).await;
}

/// `(variant, eventCount, payloadSize, pushBatchSize)`: push in batches, then pull everything back.
async fn batch_scenario(test: &str, scenario: (&'static str, usize, usize, usize)) {
    each(test, |p, b| async move {
        let (variant, event_count, payload_size, push_batch_size) = scenario;
        assert!(event_count * payload_size >= 1_000_000);
        let text = "x".repeat(payload_size);
        let mut f = EventFactory::new(ClientIdentity::with_session(
            &format!("{variant}-client"),
            &format!("{variant}-session"),
        ));
        let events: Vec<_> = (0..event_count)
            .map(|i| todo(&mut f, &format!("{variant}-{i}"), &text))
            .collect();
        for chunk in events.chunks(push_batch_size) {
            b.push(chunk.to_vec()).await.unwrap();
        }
        let stats = collect(&b, None).await;
        assert_eq!(
            stats.iter().map(|r| r.batch.len()).sum::<usize>(),
            event_count,
            "{variant} {event_count}x{payload_size}"
        );
        let non_empty = stats.iter().filter(|r| !r.batch.is_empty()).count();
        assert!(non_empty > 0);
        if variant == "manySmall" && p.name.to_lowercase().contains("cloudflare") {
            assert!(non_empty > 1);
        }
    })
    .await;
}

/// cf-ws-do only: the worker closes the sockets and refuses upgrades for 20 s; a leader must reconnect
/// with bounded retries and apply an event pushed meanwhile soon after reconnecting.
#[tokio::test]
async fn live_pull_resumes_pulling_events_pushed_after_a_socket_drop() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let Some(url) = backend().await else { return };
    if !common::providers::is_provider_selected("cf-ws-do") {
        return;
    }
    let store_id = unique("socket-drop");
    let reader = (common::providers::PROVIDERS
        .iter()
        .find(|p| p.key == "cf-ws-do")
        .unwrap()
        .make)(&url);
    let pull_attempts = Arc::new(AtomicUsize::new(0));
    let (subscribed, offline) = (
        Arc::new(tokio::sync::watch::channel(false).0),
        Arc::new(tokio::sync::watch::channel(false).0),
    );
    let connected_rx = Arc::new(std::sync::Mutex::new(None));
    let (pa, sub, off, crx) = (
        pull_attempts.clone(),
        subscribed.clone(),
        offline.clone(),
        connected_rx.clone(),
    );
    let ctor = livestore_sync::constructor(move |args| {
        let (reader, pa, sub, off, crx) = (
            reader.clone(),
            pa.clone(),
            sub.clone(),
            off.clone(),
            crx.clone(),
        );
        async move {
            let inner = reader(args).await?;
            *crx.lock().unwrap() = Some(inner.is_connected());
            let o =
                livestore_sync::BackendOverride::new(inner).pull(move |inner, cursor, options| {
                    assert!(
                        pa.fetch_add(1, Ordering::SeqCst) < 1_000,
                        "Pull retry loop exceeded 1,000 attempts"
                    );
                    let (sub, off) = (sub.clone(), off.clone());
                    inner
                        .pull(cursor, options)
                        .inspect(move |r| match r {
                            Ok(_) => _ = sub.send_replace(true),
                            Err(livestore_sync::PullError::IsOffline(_)) => {
                                _ = off.send_replace(true)
                            }
                            Err(_) => {}
                        })
                        .boxed()
                });
            Ok(Arc::new(o) as Arc<dyn SyncBackend>)
        }
    });
    let leader = livestore_sync::Leader::builder(livestore_todomvc::schema())
        .store_id(&store_id)
        .client_id("reader")
        .sync(livestore_sync::SyncOptions {
            backend: Some(ctor),
            live_pull: Some(true),
            ..Default::default()
        })
        .boot()
        .await
        .unwrap();
    subscribed.subscribe().wait_for(|v| *v).await.unwrap();
    let mut connected = connected_rx.lock().unwrap().take().unwrap();
    let reconnected = tokio::spawn(async move {
        connected.wait_for(|c| !*c).await.unwrap();
        connected.wait_for(|c| *c).await.unwrap();
        tokio::time::Instant::now()
    });
    let mut state = leader.sync_state();
    let applied = tokio::spawn(async move {
        state
            .wait_for(|s| s.upstream_head.global == 1)
            .await
            .unwrap();
        tokio::time::Instant::now()
    });

    let base = http_base(&url);
    let closed: serde_json::Value = reqwest::Client::new()
        .post(format!(
            "{base}/instance/close-websockets?storeId={store_id}"
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(closed, json!({"count": 1}));
    timeout(
        Duration::from_secs(20),
        offline.subscribe().wait_for(|v| *v),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::sleep(Duration::from_secs(20)).await;
    let outage = get_json(&format!(
        "{base}/instance/websocket-outage?storeId={store_id}"
    ))
    .await;
    let open_attempts = outage["openAttempts"].as_u64().unwrap();
    let attempts = pull_attempts.load(Ordering::SeqCst);
    eprintln!(
        "20-second WebSocket outage retry counts: pullAttempts {attempts}, openAttempts {open_attempts}"
    );
    assert!(attempts <= 12);
    assert!((1..=12).contains(&open_attempts));

    let writer = make_backend(
        &(common::providers::PROVIDERS
            .iter()
            .find(|p| p.key == "cf-ws-do")
            .unwrap()
            .make)(&url),
        &store_id,
        None,
    )
    .await;
    writer
        .push(vec![factory().next(
            "v1.TodoCreated",
            json!({"id": "after-reconnect", "text": "After reconnect"}),
        )])
        .await
        .unwrap();
    let connected_at = timeout(Duration::from_secs(40), reconnected)
        .await
        .expect("never reconnected")
        .unwrap();
    let applied_at = timeout(Duration::from_secs(2), applied)
        .await
        .expect("not applied within 2s of reconnecting")
        .unwrap();
    assert!(applied_at.saturating_duration_since(connected_at) <= Duration::from_secs(2));
    let ids: Vec<_> = leader
        .query("SELECT id FROM todos")
        .unwrap()
        .into_iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(ids, [json!("after-reconnect")]);
}

#[tokio::test]
async fn non_live_pull_returns_multiple_events() {
    each("multi", |_, b| async move {
        let mut f = factory();
        for i in 0..2 {
            b.push(vec![f.next("todoCreated", json!({"id": format!("multi-{i}"), "text": format!("Event {i}"), "completed": i % 2 == 0}))]).await.unwrap();
        }
        let pulled: usize = collect(&b, None).await.iter().map(|r| r.batch.len()).sum();
        assert!(pulled >= 2);
    })
    .await;
}

#[tokio::test]
async fn connection_management_can_reconnect_to_sync_backend() {
    each("reconnect", |_, b| async move {
        let fiber = tokio::spawn(first_non_empty(b.clone()));
        // `turnBackendOffline` / `turnBackendOnline` are no-ops for the Cloudflare providers.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut f = factory();
        f.advance_to(1, Sequence::Root);
        b.push(vec![todo(&mut f, "1", "Test event 1.")])
            .await
            .unwrap();
        assert_eq!(fiber.await.unwrap().batch.len(), 1);
    })
    .await;
}

#[tokio::test]
async fn remaining_field_works_correctly() {
    each("remaining", |_, b| async move {
        let mut f = factory();
        for i in 0..5 {
            b.push(vec![f.next("todoCreated", json!({"id": format!("remaining-test-{i}"), "text": format!("Event {i}"), "completed": false}))]).await.unwrap();
        }
        assert!(!collect(&b, None).await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn remaining_field_with_limited_take() {
    each("limited", |_, b| async move {
        let mut f = EventFactory::starting_at(ClientIdentity::with_session("test-client", "test-session"), 100, Sequence::Root);
        for i in 0..10 {
            b.push(vec![f.next("todoCreated", json!({"id": format!("limited-{i}"), "text": format!("Limited Event {i}"), "completed": false}))]).await.unwrap();
        }
        let limited: Vec<_> = b.pull(None, ONCE).take(3).map(Result::unwrap).collect().await;
        assert!((1..=3).contains(&limited.len()));
        let limited_count: usize = limited.iter().map(|r| r.batch.len()).sum();
        let all = collect(&b, None).await;
        let total: usize = all.iter().map(|r| r.batch.len()).sum();
        assert!(total > 0);
        if limited.len() < all.len() {
            assert!(limited_count < total);
        }
    })
    .await;
}

#[tokio::test]
async fn large_batch_pagination() {
    each("large-batch-test", |_, b| async move {
        const TOTAL: i64 = 10_000;
        const START: i64 = 20_000;
        let mut f = EventFactory::starting_at(ClientIdentity::with_session("test-client", "test-session"), START, Sequence::Root);
        let events: Vec<_> = (0..TOTAL).map(|i| f.next("todoCreated", json!({"id": format!("batch-{i}"), "text": format!("Event {i}"), "completed": false}))).collect();
        for chunk in events.chunks(100) {
            b.push(chunk.to_vec()).await.unwrap();
        }
        let all: Vec<_> = collect(&b, None).await.into_iter().flat_map(|r| r.batch).collect();
        if !all.is_empty() {
            assert!(all.len() >= 100);
        }
        if all.len() == TOTAL as usize {
            for (i, item) in all.iter().take(100).enumerate() {
                assert_eq!(item.event_encoded.seq_num, START + i as i64);
            }
        }
        if all.len() >= 500 {
            let middle = &all[all.len() / 2];
            let cursor = PullCursor { event_sequence_number: middle.event_encoded.seq_num, metadata: middle.metadata.clone() };
            let from_middle: Vec<_> = collect(&b, Some(cursor)).await.into_iter().flat_map(|r| r.batch).collect();
            if let Some(first) = from_middle.first() {
                assert!(first.event_encoded.seq_num > middle.event_encoded.seq_num);
            }
        }
    })
    .await;
}

#[tokio::test]
async fn backend_id_mismatch_error_serializes_correctly() {
    each("backend-id-mismatch", |_, _| async move {
        let original = BackendError::BackendIdMismatchError {
            expected: "expected-backend-id-123".into(),
            received: "received-backend-id-456".into(),
        };
        let encoded: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        assert_eq!(encoded["_tag"], "BackendIdMismatchError");
        assert_eq!(encoded["expected"], "expected-backend-id-123");
        assert_eq!(encoded["received"], "received-backend-id-456");
    })
    .await;
}
