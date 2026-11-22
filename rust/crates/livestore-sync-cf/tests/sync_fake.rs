//! Sync loop against an in-process scripted sync-cf backend (same wire protocol, no wrangler needed).

use std::sync::{Arc, Mutex};
use std::time::Duration;

mod common;

use common::TestStore as Store;
use common::{Options, start};
use futures_util::{SinkExt, StreamExt};
use livestore_sqlite::{LeaderDb, LocalLeader};
use livestore_sync_cf::transport::{
    ClientMessage, GlobalEvent, PullRequest, PushRequest, RequestId,
};
use livestore_todomvc::TodoCreated;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const T: Duration = Duration::from_secs(10);

#[tokio::test]
async fn server_ahead_waits_for_pull_then_pushes_rebased_events() {
    let fake = Fake::start().await;
    fake.preload(
        &(1..=3)
            .map(|n| other(n, &format!("o{n}")))
            .collect::<Vec<_>>(),
    );
    fake.set(|s| {
        s.pull_delay = Duration::from_millis(300);
        s.page_size = 1;
    });

    let store = start(leader_with(&["a", "b"]), "rust", fake.options()).await;
    assert!(store.wait_synced(T).await, "{:?}", store.info());

    let st = fake.state();
    // Like TS, every applied page replaces the push plan, so each separately applied page may retry
    // the push once more; pages that queue up meanwhile are coalesced.
    assert!(
        (1..=3).contains(&st.server_ahead_count),
        "first push hit ServerAheadError: {}",
        st.server_ahead_count
    );
    assert_eq!(seqs(&st.events), [1, 2, 3, 4, 5]);
    assert_eq!(st.events[3].args["id"], "a");
    assert_eq!(ids(&store), ["a", "b", "o1", "o2", "o3"]);
    assert_eq!(store.info().upstream_head.global, 5);
}

#[tokio::test]
async fn reconnects_after_drop_and_resumes_from_cursor() {
    let fake = Fake::start().await;
    let store = start(leader_with(&["a"]), "rust", fake.options()).await;
    assert!(store.wait_synced(T).await);
    let pulls_before = fake.state().pull_cursors.len();

    fake.drop_connections();
    fake.preload(&[other(2, "o2")]);
    store
        .commit(TodoCreated {
            id: "b".into(),
            text: "b".into(),
        })
        .unwrap();

    wait_until(|| fake.state().events.len() == 3 && store.info().pending == 0).await;
    let st = fake.state();
    assert_eq!(
        st.pull_cursors[pulls_before..].first(),
        Some(&Some(1)),
        "resumed pull from the old upstream head"
    );
    assert_eq!(ids(&store), ["a", "b", "o2"]);
}

#[tokio::test]
async fn retries_failed_push_with_backoff() {
    let fake = Fake::start().await;
    fake.set(|s| s.fail_pushes = 2);
    let store = start(leader_with(&["a"]), "rust", fake.options()).await;
    assert!(store.wait_synced(T).await);
    assert_eq!(fake.state().fail_pushes, 0);
    assert_eq!(seqs(&fake.state().events), [1]);
}

#[tokio::test]
async fn backend_id_mismatch_resets_local_data_and_stops() {
    let fake = Fake::start().await;
    let store = start(leader_with(&["a"]), "rust", fake.options()).await;
    assert!(store.wait_synced(T).await);

    fake.set(|s| {
        s.backend_id = "backend-2".into();
        s.events.clear();
    });
    fake.drop_connections();

    // TS `onBackendIdMismatch: 'reset'`: wipe local data, then shut down with an intentional cause.
    wait_until(|| store.info().stopped.is_some()).await;
    assert!(store.info().stopped.unwrap().contains("BackendIdMismatch"));
    let count: i64 = store
        .leader()
        .db()
        .lock()
        .unwrap()
        .eventlog_conn()
        .query_row("SELECT count(*) FROM eventlog", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(store.info().backend_id, None);
}

#[tokio::test]
async fn ignores_live_pages_delivered_twice() {
    let fake = Fake::start().await;
    fake.set(|s| s.duplicate_live = true);
    let store = start(leader_with(&[]), "rust", fake.options()).await;
    assert!(store.wait_synced(T).await);
    store
        .commit(TodoCreated {
            id: "a".into(),
            text: "a".into(),
        })
        .unwrap();
    wait_until(|| store.info().upstream_head.global == 1).await;
    fake.preload(&[other(2, "o2")]);
    wait_until(|| store.info().upstream_head.global == 2).await;
    assert_eq!(store.info().stopped, None);
    assert_eq!(ids(&store), ["a", "o2"]);
}

// ---------- helpers ----------

fn leader_with(todos: &[&str]) -> LeaderDb {
    let mut leader =
        LocalLeader::open_in_memory(livestore_todomvc::schema(), "rust", "rust-session").unwrap();
    for id in todos {
        leader
            .commit(TodoCreated {
                id: (*id).to_owned(),
                text: (*id).to_owned(),
            })
            .unwrap();
    }
    leader.into_db()
}

fn other(seq: i64, id: &str) -> GlobalEvent {
    GlobalEvent {
        name: "v1.TodoCreated".into(),
        args: json!({"id": id, "text": id}),
        seq_num: seq,
        parent_seq_num: seq - 1,
        client_id: "other".into(),
        session_id: "other-session".into(),
    }
}

fn ids(store: &Store) -> Vec<String> {
    store
        .query("SELECT id FROM todos ORDER BY id")
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect()
}

fn seqs(events: &[GlobalEvent]) -> Vec<i64> {
    events.iter().map(|e| e.seq_num).collect()
}

async fn wait_until(mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + T;
    while !f() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition not reached in time"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

struct FakeState {
    backend_id: String,
    events: Vec<GlobalEvent>,
    live: Vec<(mpsc::UnboundedSender<String>, RequestId)>,
    conns: Vec<mpsc::UnboundedSender<String>>,
    pull_delay: Duration,
    page_size: usize,
    /// Sends every live page twice, like the real DO occasionally does.
    duplicate_live: bool,
    fail_pushes: u32,
    server_ahead_count: u32,
    /// `eventSequenceNumber` of each pull's cursor, in order.
    pull_cursors: Vec<Option<i64>>,
}

#[derive(Clone)]
struct Fake {
    url: String,
    state: Arc<Mutex<FakeState>>,
}

impl Fake {
    async fn start() -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(FakeState {
            backend_id: "backend-1".into(),
            events: vec![],
            live: vec![],
            conns: vec![],
            pull_delay: Duration::ZERO,
            page_size: 100,
            duplicate_live: false,
            fail_pushes: 0,
            server_ahead_count: 0,
            pull_cursors: vec![],
        }));
        let fake = Fake { url, state };
        let server = fake.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(server.clone().serve(tcp));
            }
        });
        fake
    }

    fn options(&self) -> Options {
        Options {
            url: self.url.clone(),
            store_id: "fake-store".into(),
            payload: None,
            backoff_base: Duration::from_millis(50),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().unwrap()
    }

    fn set(&self, f: impl FnOnce(&mut FakeState)) {
        f(&mut self.state());
    }

    /// Appends events as if pushed by another client (broadcast to live pulls).
    fn preload(&self, events: &[GlobalEvent]) {
        let mut st = self.state();
        st.events.extend(events.iter().cloned());
        broadcast(&mut st, events);
    }

    fn drop_connections(&self) {
        let mut st = self.state();
        st.live.clear();
        for c in st.conns.drain(..) {
            let _ = c.send(String::new());
        }
    }

    async fn serve(self, tcp: tokio::net::TcpStream) {
        let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        self.state().conns.push(tx.clone());
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                if frame.is_empty() || sink.send(Message::text(frame)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        while let Some(Ok(msg)) = source.next().await {
            let Message::Text(text) = msg else { continue };
            if text.as_str() == r#"{"_tag":"Ping"}"# {
                let _ = tx.send(r#"{"_tag":"Pong"}"#.into());
                continue;
            }
            let Ok(ClientMessage::Request(req)) = serde_json::from_str(text.as_str()) else {
                continue;
            };
            match req.tag.as_str() {
                "SyncWsRpc.Pull" => {
                    let (fake, tx) = (self.clone(), tx.clone());
                    let pull = serde_json::from_value(req.payload).unwrap();
                    tokio::spawn(async move { fake.pull(&tx, req.id, pull).await });
                }
                "SyncWsRpc.Push" => {
                    self.push(&tx, &req.id, &serde_json::from_value(req.payload).unwrap());
                }
                other => panic!("unexpected request {other}"),
            }
        }
    }

    async fn pull(&self, tx: &mpsc::UnboundedSender<String>, id: RequestId, req: PullRequest) {
        let delay = self.state().pull_delay;
        tokio::time::sleep(delay).await;
        let mut st = self.state();
        let cursor: Option<_> = req.cursor.into();
        st.pull_cursors.push(
            cursor
                .as_ref()
                .map(|c: &livestore_sync_cf::transport::PullCursor| c.event_sequence_number),
        );
        if let Some(c) = &cursor
            && c.backend_id != st.backend_id
        {
            let error = json!({"_tag": "BackendIdMismatchError", "expected": st.backend_id, "received": c.backend_id});
            let _ = tx.send(failure(&id, &error));
            return;
        }
        let from = cursor.map_or(0, |c| c.event_sequence_number);
        let history: Vec<GlobalEvent> = st
            .events
            .iter()
            .filter(|e| e.seq_num > from)
            .cloned()
            .collect();
        let chunks: Vec<&[GlobalEvent]> = history.chunks(st.page_size).collect();
        if chunks.is_empty() {
            let _ = tx.send(chunk(&id, &st.backend_id, &[], 0));
        }
        for (i, page) in chunks.iter().enumerate() {
            let remaining: usize = chunks[i + 1..].iter().map(|c| c.len()).sum();
            let _ = tx.send(chunk(&id, &st.backend_id, page, remaining));
        }
        st.live.push((tx.clone(), id));
    }

    fn push(&self, tx: &mpsc::UnboundedSender<String>, id: &RequestId, req: &PushRequest) {
        let mut st = self.state();
        if st.fail_pushes > 0 {
            st.fail_pushes -= 1;
            let _ = tx.send(failure(
                id,
                &json!({"_tag": "UnknownError", "cause": "scripted"}),
            ));
            return;
        }
        let expected = st.events.last().map_or(0, |e| e.seq_num) + 1;
        let provided = req.batch[0].seq_num;
        if provided != expected {
            st.server_ahead_count += 1;
            let error = json!({"_tag": "ServerAheadError", "minimumExpectedNum": expected, "providedNum": provided});
            let _ = tx.send(failure(id, &error));
            return;
        }
        st.events.extend(req.batch.iter().cloned());
        broadcast(&mut st, &req.batch);
        let _ = tx.send(
            json!({"_tag": "Exit", "requestId": id, "exit": {"_tag": "Success", "value": {}}})
                .to_string(),
        );
    }
}

fn broadcast(st: &mut FakeState, events: &[GlobalEvent]) {
    let backend_id = st.backend_id.clone();
    let times = if st.duplicate_live { 2 } else { 1 };
    st.live
        .retain(|(tx, id)| (0..times).all(|_| tx.send(chunk(id, &backend_id, events, 0)).is_ok()));
}

fn chunk(id: &RequestId, backend_id: &str, events: &[GlobalEvent], remaining: usize) -> String {
    let page_info = if remaining == 0 {
        json!({"_tag": "NoMore"})
    } else {
        json!({"_tag": "MoreKnown", "remaining": remaining})
    };
    let batch: Vec<Value> = events
        .iter()
        .map(|e| json!({"eventEncoded": e, "metadata": {"_tag": "None"}}))
        .collect();
    let response = json!({"batch": batch, "pageInfo": page_info, "backendId": backend_id});
    json!({"_tag": "Chunk", "requestId": id, "values": [response]}).to_string()
}

fn failure(id: &RequestId, error: &Value) -> String {
    json!({"_tag": "Exit", "requestId": id, "exit": {"_tag": "Failure", "cause": [{"_tag": "Fail", "error": error}]}})
        .to_string()
}
