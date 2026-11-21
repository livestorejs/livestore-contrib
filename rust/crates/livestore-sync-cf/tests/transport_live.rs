//! Against a real sync-cf backend. Run via `scripts/test-live.sh`, or start wrangler yourself
//! (see contributor-docs/rust/sync-cf-wire-protocol.md §1) and set `LIVESTORE_SYNC_URL=ws://localhost:8787`.
//! Tests skip (pass) when no backend is reachable.

use std::time::Duration;

use livestore_sync_cf::transport::*;
use serde_json::json;
use tokio::time::timeout;

const T: Duration = Duration::from_secs(10);

async fn backend() -> Option<String> {
    let url =
        std::env::var("LIVESTORE_SYNC_URL").unwrap_or_else(|_| "ws://localhost:8787".to_owned());
    let addr = url
        .trim_start_matches("ws://")
        .trim_start_matches("wss://")
        .trim_end_matches('/')
        .to_owned();
    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
        Some(url)
    } else {
        eprintln!("SKIP: no sync backend at {url}");
        None
    }
}

fn store_id(name: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("rust-{name}-{nanos}")
}

fn events(from: i64, to: i64) -> Vec<GlobalEvent> {
    (from..=to)
        .map(|n| GlobalEvent {
            name: "todoCreated-v1".into(),
            args: json!({"id": format!("todo-{n}"), "text": format!("Todo {n}")}),
            seq_num: n,
            parent_seq_num: n - 1,
            client_id: "rust-client".into(),
            session_id: "rust-session".into(),
        })
        .collect()
}

async fn next(s: &mut PullStream) -> Option<Result<PullResponse, SyncError>> {
    timeout(T, s.next()).await.expect("pull timed out")
}

async fn pull_all(c: &Client, cursor: Option<PullCursor>) -> Vec<PullResponse> {
    let mut s = c.pull(cursor, false).unwrap();
    let mut out = vec![];
    while let Some(r) = next(&mut s).await {
        out.push(r.unwrap());
    }
    out
}

async fn setup(name: &str) -> Option<Client> {
    let url = backend().await?;
    Some(
        connect(
            &url,
            &store_id(name),
            Some(json!({"authToken": "insecure-token"})),
        )
        .await
        .unwrap(),
    )
}

#[tokio::test]
async fn empty_pull() {
    let Some(c) = setup("empty").await else {
        return;
    };
    let rs = pull_all(&c, None).await;
    assert_eq!(rs.len(), 1);
    assert_eq!(rs[0].batch.len(), 0);
    assert_eq!(rs[0].page_info, PageInfo::NoMore);
    assert_eq!(rs[0].backend_id.len(), 21);
}

#[tokio::test]
async fn push_then_pull_with_cursor() {
    let Some(c) = setup("pushpull").await else {
        return;
    };
    c.push(events(1, 3), None).await.unwrap();
    let rs = pull_all(&c, None).await;
    let seqs: Vec<i64> = rs
        .iter()
        .flat_map(|r| &r.batch)
        .map(|i| i.event_encoded.seq_num)
        .collect();
    assert_eq!(seqs, [1, 2, 3]);
    assert_eq!(rs[0].batch[0].event_encoded, events(1, 1)[0]);

    let cursor = PullCursor {
        backend_id: rs[0].backend_id.clone(),
        event_sequence_number: 1,
    };
    let rs = pull_all(&c, Some(cursor)).await;
    let seqs: Vec<i64> = rs
        .iter()
        .flat_map(|r| &r.batch)
        .map(|i| i.event_encoded.seq_num)
        .collect();
    assert_eq!(seqs, [2, 3]);
}

#[tokio::test]
async fn paged_history_is_acked() {
    let Some(c) = setup("paged").await else {
        return;
    };
    for start in [1, 101, 201] {
        c.push(events(start, start + 99), None).await.unwrap();
    }
    c.push(events(301, 310), None).await.unwrap();
    let rs = pull_all(&c, None).await;
    // Page sizes are not fixed at 100 (observed 100,100,56,54); check the invariants instead.
    assert!(rs.len() >= 4 && rs.iter().all(|r| r.batch.len() <= 100));
    let seqs: Vec<i64> = rs
        .iter()
        .flat_map(|r| &r.batch)
        .map(|i| i.event_encoded.seq_num)
        .collect();
    assert_eq!(seqs, (1..=310).collect::<Vec<_>>());
    let mut seen: i64 = 0;
    for (i, r) in rs.iter().enumerate() {
        seen += i64::try_from(r.batch.len()).unwrap();
        let expected = if i + 1 == rs.len() {
            PageInfo::NoMore
        } else {
            PageInfo::MoreKnown {
                remaining: u64::try_from(310 - seen).unwrap(),
            }
        };
        assert_eq!(r.page_info, expected);
    }
}

#[tokio::test]
async fn live_pull_sees_other_socket_push_and_interrupt_ends_it() {
    let Some(url) = backend().await else { return };
    let id = store_id("live");
    let a = connect(&url, &id, None).await.unwrap();
    let b = connect(&url, &id, None).await.unwrap();
    a.push(events(1, 2), None).await.unwrap();

    let mut live = a.pull(None, true).unwrap();
    let first = next(&mut live).await.unwrap().unwrap();
    assert_eq!(first.batch.len(), 2);
    assert_eq!(first.page_info, PageInfo::NoMore);

    b.push(events(3, 3), Some(first.backend_id.clone()))
        .await
        .unwrap();
    let update = next(&mut live).await.unwrap().unwrap();
    assert_eq!(update.batch[0].event_encoded.seq_num, 3);
    assert!(matches!(update.batch[0].metadata, WireOption::Some { .. }));

    live.interrupt().unwrap();
    assert!(next(&mut live).await.is_none());
    // Socket still usable after the interrupt.
    assert_eq!(pull_all(&a, None).await[0].batch.len(), 3);
}

#[tokio::test]
async fn concurrent_requests_multiplex() {
    let Some(c) = setup("mux").await else { return };
    c.push(events(1, 150), None).await.ok();
    let mut live = c.pull(None, true).unwrap();
    let (r1, r2) = tokio::join!(pull_all(&c, None), c.push(events(151, 151), None));
    r2.unwrap();
    assert!(r1.iter().map(|r| r.batch.len()).sum::<usize>() >= 150);
    let mut seen = 0;
    while seen < 151 {
        seen += next(&mut live).await.unwrap().unwrap().batch.len();
    }
}

#[tokio::test]
async fn server_ahead_error() {
    let Some(c) = setup("ahead").await else {
        return;
    };
    c.push(events(1, 5), None).await.unwrap();
    let err = c.push(events(3, 3), None).await.unwrap_err();
    assert_eq!(
        err,
        SyncError::ServerAhead {
            minimum_expected_num: 5,
            provided_num: 2
        }
    );
}

#[tokio::test]
async fn backend_id_mismatch_on_push_and_pull() {
    let Some(c) = setup("mismatch").await else {
        return;
    };
    let real = pull_all(&c, None).await[0].backend_id.clone();
    let err = c
        .push(events(1, 1), Some("wrong".into()))
        .await
        .unwrap_err();
    assert_eq!(
        err,
        SyncError::BackendIdMismatch {
            expected: real.clone(),
            received: "wrong".into()
        }
    );

    let mut s = c
        .pull(
            Some(PullCursor {
                backend_id: "wrong".into(),
                event_sequence_number: 0,
            }),
            false,
        )
        .unwrap();
    assert!(matches!(
        next(&mut s).await,
        Some(Err(SyncError::BackendIdMismatch { .. }))
    ));
    assert!(next(&mut s).await.is_none());
}

#[tokio::test]
async fn ping_pong_and_keepalive() {
    let Some(url) = backend().await else { return };
    let opts = ClientOptions {
        ping_interval: Duration::from_millis(200),
        pong_timeout: Duration::from_secs(2),
    };
    let c = connect_with(&url, &store_id("ping"), None, opts)
        .await
        .unwrap();
    c.ping(T).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(c.closed_reason(), None);
    c.close();
    assert!(matches!(c.ping(T).await, Err(SyncError::Socket(_))));
    assert!(matches!(
        c.push(events(1, 1), None).await,
        Err(SyncError::Socket(_))
    ));
}
