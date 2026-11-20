//! The transport-generic parts of the DO-RPC client tests, ported onto the WebSocket client:
//! `sync-cf/src/client/transport/do-rpc-client.test.ts` (error classification, recovery on a fresh
//! connection, idle live pull) and `tests/sync-provider/src/do-rpc-transport-recovery.test.ts`
//! (leader recovery after a broken or rejected pull). Transport loss is simulated with a TCP proxy.

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use futures::StreamExt;
use futures::stream;
use livestore_sync::testing::{ClientIdentity, EventFactory, Sequence};
use livestore_sync::*;
use livestore_sync_cf::make_ws_sync;
use livestore_sync_cf::transport::ClientOptions;
use serde_json::json;
use tokio::time::timeout;

const T: Duration = Duration::from_secs(15);

fn ws() -> fn(&str) -> SyncBackendConstructor {
    |url| make_ws_sync(url, ClientOptions::default())
}

fn event(seq: i64, parent: i64) -> livestore_core::GlobalEvent {
    let mut f = EventFactory::starting_at(
        ClientIdentity::with_session("client", "session"),
        seq,
        if parent == 0 {
            Sequence::Root
        } else {
            Sequence::At(parent)
        },
    );
    f.next("todoCreated", json!({}))
}

async fn offline_backend() -> Option<(FaultProxy, Arc<dyn SyncBackend>)> {
    let url = backend().await?;
    let proxy = FaultProxy::start(&url).await;
    proxy.offline();
    let b = make_backend(&ws()(&proxy.url), &unique("rpc-offline"), None).await;
    Some((proxy, b))
}

#[tokio::test]
async fn a_retryable_rejection_fails_the_pull_as_offline() {
    let Some((_proxy, b)) = offline_backend().await else {
        return;
    };
    let items: Vec<_> = timeout(T, b.pull(None, PullOptions::default()).collect())
        .await
        .unwrap();
    assert!(
        matches!(items.last(), Some(Err(PullError::IsOffline(_)))),
        "{items:?}"
    );
}

#[tokio::test]
async fn a_retryable_push_rejection_fails_as_offline() {
    let Some((_proxy, b)) = offline_backend().await else {
        return;
    };
    let r = timeout(T, b.push(vec![event(1, 0)])).await.unwrap();
    assert!(matches!(r, Err(PushError::IsOffline(_))), "{r:?}");
}

#[tokio::test]
async fn a_retryable_ping_rejection_fails_as_offline() {
    let Some((_proxy, b)) = offline_backend().await else {
        return;
    };
    let r = timeout(T, b.ping()).await.unwrap();
    assert!(matches!(r, Err(PingError::IsOffline(_))), "{r:?}");
}

#[tokio::test]
async fn passes_application_errors_through_unchanged_pull_backend_id_mismatch_error() {
    let Some(url) = backend().await else { return };
    let backend_id = Arc::new(MemBackendId::default());
    backend_id.set("stale-backend");
    let args = MakeBackendArgs {
        store_id: unique("rpc-mismatch"),
        client_id: "client".into(),
        payload: None,
        backend_id,
    };
    let b = ws()(&url)(args).await.unwrap();
    let cursor = PullCursor {
        event_sequence_number: 0,
        metadata: None,
    };
    let items: Vec<_> = timeout(T, b.pull(Some(cursor), PullOptions::default()).collect())
        .await
        .unwrap();
    assert!(
        matches!(items.last(), Some(Err(PullError::BackendIdMismatch(_)))),
        "{items:?}"
    );
}

#[tokio::test]
async fn passes_application_errors_through_unchanged_push_server_ahead_error() {
    let Some(url) = backend().await else { return };
    let b = make_backend(&ws()(&url), &unique("rpc-server-ahead"), None).await;
    b.push(vec![event(1, 0)]).await.unwrap();
    let r = timeout(T, b.push(vec![event(1, 0)])).await.unwrap();
    assert_eq!(
        r,
        Err(ServerAheadError {
            minimum_expected_num: 1,
            provided_num: 0
        }
        .into())
    );
}

#[tokio::test]
async fn recovers_on_a_fresh_connection_after_a_connection_breaks() {
    let Some(url) = backend().await else { return };
    let proxy = FaultProxy::start(&url).await;
    let b = make_backend(&ws()(&proxy.url), &unique("rpc-recover"), None).await;
    proxy.offline();
    let first: Vec<_> = timeout(T, b.pull(None, PullOptions::default()).collect())
        .await
        .unwrap();
    proxy.online();
    let second: Vec<_> = timeout(T, b.pull(None, PullOptions::default()).collect())
        .await
        .unwrap();
    assert!(
        matches!(first.last(), Some(Err(PullError::IsOffline(_)))),
        "{first:?}"
    );
    assert_eq!(second, vec![Ok(PullResItem::empty())]);
}

#[tokio::test]
async fn a_live_pull_can_remain_idle_after_catch_up_without_reconnecting() {
    let Some(url) = backend().await else { return };
    // Many keepalive rounds within the idle window.
    let ctor = make_ws_sync(
        &url,
        ClientOptions {
            ping_interval: Duration::from_millis(100),
            pong_timeout: Duration::from_secs(5),
        },
    );
    let b = make_backend(&ctor, &unique("rpc-idle"), None).await;
    let mut pull = b.pull(None, PullOptions { live: true });
    let caught_up = timeout(T, pull.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(caught_up.page_info, PageInfo::NoMore);
    let connected = b.is_connected();
    assert!(*connected.borrow());
    assert!(
        timeout(Duration::from_secs(3), pull.next()).await.is_err(),
        "live pull ended or yielded while idle"
    );
    assert!(
        !connected.has_changed().unwrap(),
        "the connection was dropped while idle"
    );
}

/// `do-rpc-transport-recovery`: first pull delivers one page, then the stream breaks.
#[tokio::test]
async fn resumes_after_the_last_applied_event_when_a_pull_stream_breaks() {
    let Some(url) = backend().await else { return };
    let store_id = unique("recovery-break");
    let mut remote = EventFactory::new(ClientIdentity::with_session("remote", "session"));
    let (a, b) = (
        remote.next("v1.TodoCreated", json!({"id": "a", "text": "A"})),
        remote.next("v1.TodoCreated", json!({"id": "b", "text": "B"})),
    );
    make_backend(&ws()(&url), &store_id, None)
        .await
        .push(vec![a, b])
        .await
        .unwrap();

    let cursors = Arc::new(Mutex::new(Vec::<Option<i64>>::new()));
    let first_call = Arc::new(AtomicBool::new(true));
    let (ws_ctor, c, fc) = (ws()(&url), cursors.clone(), first_call.clone());
    let ctor = constructor(move |args| {
        let (ws_ctor, c, fc) = (ws_ctor.clone(), c.clone(), fc.clone());
        async move {
            let inner = ws_ctor(args).await?;
            let o = BackendOverride::new(inner).pull(move |inner, cursor, options| {
                c.lock()
                    .unwrap()
                    .push(cursor.as_ref().map(|c| c.event_sequence_number));
                if !fc.swap(false, Ordering::SeqCst) {
                    return inner.pull(cursor, options);
                }
                inner
                    .pull(cursor, options)
                    .take(1)
                    .map(|r| {
                        r.map(|mut page| {
                            page.batch.truncate(1);
                            page.page_info = PageInfo::MoreUnknown;
                            page
                        })
                    })
                    .chain(stream::iter([Err(IsOfflineError {
                        cause: "ReadableStream received over RPC disconnected prematurely.".into(),
                    }
                    .into())]))
                    .boxed()
            });
            Ok(Arc::new(o) as Arc<dyn SyncBackend>)
        }
    });
    let leader = leader(&store_id, ctor).await;

    let mut state = leader.sync_state();
    let mut heads = vec![];
    timeout(Duration::from_secs(5), async {
        loop {
            let head = state.borrow_and_update().upstream_head.global;
            if heads.last() != Some(&head) {
                heads.push(head);
            }
            if head == 2 {
                break;
            }
            state.changed().await.unwrap();
        }
    })
    .await
    .expect("leader never applied both events");

    assert_eq!(*cursors.lock().unwrap(), [None, Some(1)]);
    assert_eq!(
        heads.into_iter().filter(|h| *h > 0).collect::<Vec<_>>(),
        [1, 2]
    );
    let todos = leader
        .query("SELECT id, text, completed FROM todos ORDER BY id")
        .unwrap();
    assert_eq!(
        serde_json::to_value(todos).unwrap(),
        json!([{"id": "a", "text": "A", "completed": 0}, {"id": "b", "text": "B", "completed": 0}])
    );
}

#[tokio::test]
async fn a_push_parked_on_server_ahead_error_resumes_once_a_retryable_pull_failure_recovers() {
    let Some(url) = backend().await else { return };
    let store_id = unique("recovery-parked");
    let mut other = EventFactory::new(ClientIdentity::with_session(
        "other-client",
        "other-session",
    ));
    let writer = make_backend(&ws()(&url), &store_id, None).await;
    writer
        .push(vec![other.next(
            "v1.TodoCreated",
            json!({"id": "remote", "text": "remote"}),
        )])
        .await
        .unwrap();

    let (rejected_pulls, server_ahead_pushes) =
        (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    // The TS mock rejects the push instantly; over a real socket the retried pull could win the race, so it
    // waits until the push has been parked on ServerAheadError.
    let parked = tokio::sync::watch::channel(false).0;
    let (ws_ctor, rp, sap, parked) = (
        ws()(&url),
        rejected_pulls.clone(),
        server_ahead_pushes.clone(),
        Arc::new(parked),
    );
    let ctor = constructor(move |args| {
        let (ws_ctor, rp, sap, parked, parked2) = (
            ws_ctor.clone(),
            rp.clone(),
            sap.clone(),
            parked.clone(),
            parked.clone(),
        );
        async move {
            let inner = ws_ctor(args).await?;
            let o = BackendOverride::new(inner)
                .pull(move |inner, cursor, options| {
                    if rp
                        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        return stream::iter([Err(IsOfflineError {
                            cause: "Network connection lost.".into(),
                        }
                        .into())])
                        .boxed();
                    }
                    let (inner, mut parked) = (inner.clone(), parked.subscribe());
                    stream::once(async move { timeout(T, parked.wait_for(|p| *p)).await.map(drop) })
                        .flat_map(move |_| inner.pull(cursor.clone(), options))
                        .boxed()
                })
                .push(move |inner, batch| {
                    let (push, sap, parked) = (inner.push(batch), sap.clone(), parked2.clone());
                    Box::pin(async move {
                        let r = push.await;
                        if matches!(r, Err(PushError::ServerAhead(_))) {
                            sap.fetch_add(1, Ordering::SeqCst);
                            parked.send_replace(true);
                        }
                        r
                    })
                });
            Ok(Arc::new(o) as Arc<dyn SyncBackend>)
        }
    });
    let leader = leader(&store_id, ctor).await;
    let mut local = EventFactory::new(ClientIdentity::with_session(leader.client_id(), "session"));
    leader
        .push(vec![local.next_client(
            "v1.TodoCreated",
            json!({"id": "local", "text": "local"}),
        )])
        .await
        .unwrap();

    // `mockBackend.pushedEvents.pipe(Stream.take(1))`: wait until the backend holds the local event.
    let pushed = timeout(T, async {
        loop {
            let events: Vec<_> = writer
                .pull(None, PullOptions::default())
                .map(Result::unwrap)
                .flat_map(|r| stream::iter(r.batch))
                .collect()
                .await;
            if events.len() == 2 {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("local push never landed");
    assert_eq!(
        pushed
            .iter()
            .map(|i| i.event_encoded.args["id"].clone())
            .collect::<Vec<_>>(),
        [json!("remote"), json!("local")]
    );
    assert_eq!(
        (
            rejected_pulls.load(Ordering::SeqCst),
            server_ahead_pushes.load(Ordering::SeqCst)
        ),
        (1, 1)
    );
}

async fn leader(store_id: &str, backend: SyncBackendConstructor) -> Leader {
    Leader::builder(livestore_todomvc::schema())
        .store_id(store_id)
        .client_id("test")
        .sync(SyncOptions {
            backend: Some(backend),
            live_pull: Some(false),
            ..Default::default()
        })
        .boot()
        .await
        .unwrap()
}
