#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use livestore::{Event, InMemoryAdapter, Store, StoreOptions, create_store};
use livestore_schema::codec::date_from_iso_string;
use livestore_schema::event_def::DateFromString;
use livestore_sqlite::{LeaderDb, LocalLeader, Row};
use livestore_sync::{Backoff, Leader, SyncOptions};
use livestore_sync_cf::make_ws_sync;
use livestore_sync_cf::transport::ClientOptions;
use serde_json::{Value, json};

pub const T: Duration = Duration::from_secs(20);
pub const ALL_TODOS: &str = "SELECT id, text, completed, deletedAt FROM todos ORDER BY id";
pub const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

pub async fn backend() -> Option<String> {
    let url =
        std::env::var("LIVESTORE_SYNC_URL").unwrap_or_else(|_| "ws://localhost:8787".to_owned());
    let addr = url
        .trim_start_matches("ws://")
        .trim_end_matches('/')
        .to_owned();
    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
        Some(url)
    } else {
        eprintln!("SKIP: no sync backend at {url}");
        None
    }
}

pub struct Options {
    pub url: String,
    pub store_id: String,
    pub payload: Option<Value>,
    pub backoff_base: Duration,
}

pub fn options(url: &str, store_id: &str) -> Options {
    Options {
        url: url.into(),
        store_id: store_id.into(),
        payload: Some(json!({"authToken": "insecure-token-change-me"})),
        backoff_base: Duration::from_millis(200),
    }
}

/// A store on top of a leader, with the leader kept for inspection.
pub struct TestStore {
    pub store: Store,
    leader: Leader,
}

#[derive(Debug)]
pub struct Info {
    pub pending: usize,
    pub upstream_head: livestore_core::SeqNum,
    pub stopped: Option<String>,
    pub backend_id: Option<String>,
}

impl TestStore {
    pub fn commit(&self, event: impl Event) -> Result<(), livestore::StoreError> {
        self.store.commit(event)
    }

    pub fn query(&self, sql: &str) -> Result<Vec<Row>, livestore::StoreError> {
        self.store.query_raw(sql, &[])
    }

    pub fn leader(&self) -> &Leader {
        &self.leader
    }

    pub fn info(&self) -> Info {
        let state = self.leader.sync_state().borrow().clone();
        Info {
            pending: state.pending.len(),
            upstream_head: state.upstream_head,
            stopped: self
                .leader
                .shutdown_cause()
                .borrow()
                .as_ref()
                .map(|c| format!("{c:?}")),
            backend_id: self.leader.db().lock().unwrap().backend_id().ok().flatten(),
        }
    }

    /// Nothing pending in the leader and the session caught up with it.
    pub async fn wait_synced(&self, t: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + t;
        while tokio::time::Instant::now() < deadline {
            if self.info().pending == 0 && self.store.sync_status().is_synced {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    pub async fn shutdown(self) {
        self.store.shutdown(None).await;
        self.leader.shutdown().await;
    }
}

/// Boots a leader on `db` syncing to sync-cf, with one store session on top.
pub async fn start(db: LeaderDb, client_id: &str, o: Options) -> TestStore {
    let slot = std::sync::Arc::new(std::sync::Mutex::new((Some(db), None::<Leader>)));
    let (db_slot, leader_slot, store_id, payload) = (
        slot.clone(),
        slot.clone(),
        o.store_id.clone(),
        o.payload.clone(),
    );
    let adapter = InMemoryAdapter {
        client_id: client_id.into(),
        session_id: format!("{client_id}-session"),
        sync: Some(SyncOptions {
            backend: Some(make_ws_sync(&o.url, ClientOptions::default())),
            backoff: Backoff {
                base: o.backoff_base,
                max: Duration::from_secs(2),
            },
            ..SyncOptions::default()
        }),
        make_leader_db: Some(std::sync::Arc::new(move |_| {
            db_slot
                .lock()
                .unwrap()
                .0
                .take()
                .expect("leader db is used once")
        })),
        leader_builder: Some(std::sync::Arc::new(move |b| match &payload {
            Some(p) => b.sync_payload(p.clone()),
            None => b,
        })),
        on_leader: Some(std::sync::Arc::new(move |l| {
            leader_slot.lock().unwrap().1 = Some(l.clone());
        })),
        ..InMemoryAdapter::default()
    };
    let store = create_store(StoreOptions::new(
        livestore_todomvc::schema(),
        adapter.build(),
        &store_id,
    ))
    .await
    .unwrap();
    let leader = slot
        .lock()
        .unwrap()
        .1
        .take()
        .expect("adapter booted a leader");
    TestStore { store, leader }
}

pub fn open(dir: &Path, client_id: &str) -> LocalLeader {
    LocalLeader::open(
        dir.join("state.db"),
        dir.join("eventlog.db"),
        livestore_todomvc::schema(),
        client_id,
        &format!("{client_id}-session"),
    )
    .unwrap()
}

/// A `DateFromString` from an ISO string.
pub fn date(iso: &str) -> DateFromString {
    #[expect(clippy::cast_precision_loss, reason = "epoch millis fit in f64")]
    DateFromString(date_from_iso_string(iso).expect("valid ISO date") as f64)
}

pub fn unique(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{prefix}-{nanos}")
}

pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(unique(&format!("livestore-rust-{name}")));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Waits until every store has nothing pending, `count` todos, and identical `todos` rows; returns them.
pub async fn converge(stores: &[&TestStore], count: usize) -> Vec<Row> {
    let deadline = tokio::time::Instant::now() + T;
    loop {
        let rows: Vec<Vec<Row>> = stores.iter().map(|s| s.query(ALL_TODOS).unwrap()).collect();
        let synced = stores.iter().all(|s| s.info().pending == 0);
        if synced && rows[0].len() == count && rows.iter().all(|r| r == &rows[0]) {
            return rows.into_iter().next().unwrap();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no convergence: {:?}\n{rows:#?}",
            stores.iter().map(|s| s.info()).collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub mod providers;

/// In-memory backend-id store (TS `KeyValueStore.layerMemory`).
#[derive(Default)]
pub struct MemBackendId(std::sync::Mutex<Option<String>>);

impl livestore_sync::BackendIdStore for MemBackendId {
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    fn set(&self, backend_id: &str) {
        *self.0.lock().unwrap() = Some(backend_id.to_owned());
    }
}

/// Builds a backend from a constructor (TS `makeProvider({ storeId, clientId, payload })`).
pub async fn make_backend(
    ctor: &livestore_sync::SyncBackendConstructor,
    store_id: &str,
    payload: Option<Value>,
) -> std::sync::Arc<dyn livestore_sync::SyncBackend> {
    ctor(livestore_sync::MakeBackendArgs {
        store_id: store_id.into(),
        client_id: "test-client".into(),
        payload,
        backend_id: std::sync::Arc::new(MemBackendId::default()),
    })
    .await
    .unwrap()
}

/// `http://host:port` for the worker's test endpoints.
pub fn http_base(ws_url: &str) -> String {
    ws_url
        .replacen("ws://", "http://", 1)
        .trim_end_matches('/')
        .to_owned()
}

pub async fn get_json(url: &str) -> Value {
    reqwest::get(url).await.unwrap().json().await.unwrap()
}

/// TCP proxy in front of the backend that can drop the network (`turnBackendOffline`).
pub struct FaultProxy {
    pub url: String,
    online: std::sync::Arc<std::sync::atomic::AtomicBool>,
    conns: std::sync::Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
}

impl FaultProxy {
    pub async fn start(ws_url: &str) -> FaultProxy {
        use std::sync::atomic::Ordering;
        let target = ws_url
            .trim_start_matches("ws://")
            .trim_end_matches('/')
            .to_owned();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let online = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let conns = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (on, cs) = (online.clone(), conns.clone());
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                if !on.load(Ordering::SeqCst) {
                    continue;
                }
                let target = target.clone();
                let task = tokio::spawn(async move {
                    if let Ok(mut outbound) = tokio::net::TcpStream::connect(&target).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                });
                cs.lock().unwrap().push(task.abort_handle());
            }
        });
        FaultProxy { url, online, conns }
    }

    /// Severs every open connection and refuses new ones.
    pub fn offline(&self) {
        self.online
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.conns.lock().unwrap().drain(..).for_each(|c| c.abort());
    }

    pub fn online(&self) {
        self.online.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}
