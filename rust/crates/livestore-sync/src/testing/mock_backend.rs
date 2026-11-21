use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{self, StreamExt};
use livestore_core::GlobalEvent;
use tokio::sync::{mpsc, watch};

use crate::backend::{
    BackendMetadata, PageInfo, PullCursor, PullItem, PullOptions, PullResItem, PullStream,
    Supports, SyncBackend, SyncBackendConstructor, constructor,
};
use crate::errors::{
    ConnectError, PingError, PullError, PushError, ServerAheadError, UnknownError,
};

pub type PushFailure = Arc<dyn Fn(&[GlobalEvent]) -> PushError + Send + Sync>;
pub type PullFailure = Arc<dyn Fn() -> PullError + Send + Sync>;

#[derive(Clone, Copy, Debug)]
pub struct MockSyncBackendOptions {
    /// Chunk size for non-live pulls (default 100).
    pub non_live_chunk_size: usize,
    /// Initial connected state (default false).
    pub start_connected: bool,
}

impl Default for MockSyncBackendOptions {
    fn default() -> Self {
        Self {
            non_live_chunk_size: 100,
            start_connected: false,
        }
    }
}

/// In-memory scripted backend (`makeMockSyncBackend`). Offline only shows in `is_connected`;
/// pull/push still succeed, like the TS mock.
#[derive(Clone)]
pub struct MockSyncBackend {
    shared: Arc<Shared>,
}

struct Shared {
    /// Also the TS semaphore: push/advance/new connections are serialized on it.
    state: tokio::sync::Mutex<State>,
    connected: watch::Sender<bool>,
    pushed_tx: mpsc::UnboundedSender<GlobalEvent>,
    pushed_rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<GlobalEvent>>,
    fail_push: Mutex<(usize, Option<PushFailure>)>,
    fail_pull: Mutex<(usize, Option<PullFailure>)>,
    chunk_size: usize,
}

#[derive(Default)]
struct State {
    head: i64,
    events: Vec<GlobalEvent>,
    live_queues: Vec<mpsc::UnboundedSender<GlobalEvent>>,
}

impl MockSyncBackend {
    pub fn new(options: MockSyncBackendOptions) -> Self {
        let (pushed_tx, pushed_rx) = mpsc::unbounded_channel();
        Self {
            shared: Arc::new(Shared {
                state: tokio::sync::Mutex::new(State::default()),
                connected: watch::channel(options.start_connected).0,
                pushed_tx,
                pushed_rx: tokio::sync::Mutex::new(pushed_rx),
                fail_push: Mutex::new((0, None)),
                fail_pull: Mutex::new((0, None)),
                chunk_size: options.non_live_chunk_size.max(1),
            }),
        }
    }

    pub fn connect(&self) {
        self.shared.connected.send_replace(true);
    }

    pub fn disconnect(&self) {
        self.shared.connected.send_replace(false);
    }

    /// Appends events as if pushed by another client and broadcasts them to live pulls.
    pub async fn advance(&self, batch: Vec<GlobalEvent>) {
        let mut st = self.shared.state.lock().await;
        if let Some(last) = batch.last() {
            st.head = last.seq_num;
        }
        st.events.extend(batch.iter().cloned());
        st.live_queues
            .retain(|q| batch.iter().all(|e| q.send(e.clone()).is_ok()));
    }

    /// Fails the next `count` pushes with `error(batch)` or an `UnknownError`.
    pub fn fail_next_pushes(&self, count: usize, error: Option<PushFailure>) {
        *self.shared.fail_push.lock().expect("mutex poisoned") = (count, error);
    }

    /// Fails the next `count` pulls with `error()` or an `UnknownError`.
    pub fn fail_next_pulls(&self, count: usize, error: Option<PullFailure>) {
        *self.shared.fail_pull.lock().expect("mutex poisoned") = (count, error);
    }

    /// Next event accepted by a push (`pushedEvents` stream).
    pub async fn next_pushed(&self) -> GlobalEvent {
        self.shared
            .pushed_rx
            .lock()
            .await
            .recv()
            .await
            .expect("mock backend alive")
    }

    /// `pushedEvents.pipe(Stream.take(n), Stream.runCollect)`.
    pub async fn take_pushed(&self, n: usize) -> Vec<GlobalEvent> {
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            out.push(self.next_pushed().await);
        }
        out
    }

    /// All events the backend holds.
    pub async fn events(&self) -> Vec<GlobalEvent> {
        self.shared.state.lock().await.events.clone()
    }

    /// `makeSyncBackend`: one client connection with its own live cursor.
    pub async fn make_sync_backend(&self) -> Arc<dyn SyncBackend> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut st = self.shared.state.lock().await;
        for e in &st.events {
            let _ = tx.send(e.clone());
        }
        st.live_queues.push(tx);
        Arc::new(MockClient {
            shared: self.shared.clone(),
            live: Arc::new(tokio::sync::Mutex::new(rx)),
        })
    }

    pub fn constructor(&self) -> SyncBackendConstructor {
        let mock = self.clone();
        constructor(move |_| {
            let mock = mock.clone();
            async move { Ok(mock.make_sync_backend().await) }
        })
    }
}

struct MockClient {
    shared: Arc<Shared>,
    live: Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<GlobalEvent>>>,
}

impl SyncBackend for MockClient {
    fn connect(&self) -> BoxFuture<'static, Result<(), ConnectError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            shared.connected.send_replace(true);
            Ok(())
        })
    }

    fn pull(&self, cursor: Option<PullCursor>, options: PullOptions) -> PullStream {
        let failure = consume(&self.shared.fail_pull).map(|f| {
            f.map_or_else(
                || UnknownError::new("MockSyncBackend: simulated pull failure").into(),
                |f| f(),
            )
        });
        if let Some(error) = failure {
            return stream::iter([Err(error)]).boxed();
        }
        let last_seen = cursor.map_or(0, |c| c.event_sequence_number);
        if options.live {
            let live = self.live.clone();
            let chunks = stream::unfold(live, move |live| async move {
                let batch = {
                    let mut rx = live.lock().await;
                    let first = rx.recv().await?;
                    let mut batch = vec![first];
                    while let Ok(e) = rx.try_recv() {
                        batch.push(e);
                    }
                    batch
                };
                let batch = batch
                    .into_iter()
                    .filter(|e| e.seq_num > last_seen)
                    .map(item)
                    .collect();
                Some((
                    Ok(PullResItem {
                        batch,
                        page_info: PageInfo::NoMore,
                    }),
                    live,
                ))
            });
            return stream::iter([Ok(PullResItem::empty())])
                .chain(chunks)
                .boxed();
        }
        let shared = self.shared.clone();
        stream::once(async move {
            let events: Vec<GlobalEvent> = shared
                .state
                .lock()
                .await
                .events
                .iter()
                .filter(|e| e.seq_num > last_seen)
                .cloned()
                .collect();
            let mut pages = vec![];
            for (i, chunk) in events.chunks(shared.chunk_size).enumerate() {
                let remaining = events.len() - (i * shared.chunk_size + chunk.len());
                let page_info = if remaining > 0 {
                    PageInfo::MoreKnown {
                        remaining: remaining as u64,
                    }
                } else {
                    PageInfo::NoMore
                };
                pages.push(Ok(PullResItem {
                    batch: chunk.iter().cloned().map(item).collect(),
                    page_info,
                }));
            }
            if pages.is_empty() {
                pages.push(Ok(PullResItem::empty()));
            }
            stream::iter(pages)
        })
        .flatten()
        .boxed()
    }

    fn push(&self, batch: Vec<GlobalEvent>) -> BoxFuture<'static, Result<(), PushError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            let mut st = shared.state.lock().await;
            if let Some(first) = batch.first()
                && first.seq_num <= st.head
            {
                return Err(ServerAheadError {
                    minimum_expected_num: st.head + 1,
                    provided_num: first.seq_num,
                }
                .into());
            }
            if let Some(f) = consume(&shared.fail_push) {
                return Err(f.map_or_else(
                    || UnknownError::new("MockSyncBackend: simulated push failure").into(),
                    |f| f(&batch),
                ));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            for e in &batch {
                let _ = shared.pushed_tx.send(e.clone());
            }
            st.live_queues
                .retain(|q| batch.iter().all(|e| q.send(e.clone()).is_ok()));
            st.events.extend(batch.iter().cloned());
            if let Some(last) = batch.last() {
                st.head = last.seq_num;
            }
            Ok(())
        })
    }

    fn ping(&self) -> BoxFuture<'static, Result<(), PingError>> {
        Box::pin(async { Ok(()) })
    }

    fn is_connected(&self) -> watch::Receiver<bool> {
        self.shared.connected.subscribe()
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            name: "@livestore/mock-sync".into(),
            description: "Just a mock sync backend".into(),
            extra: Default::default(),
        }
    }

    fn supports(&self) -> Supports {
        Supports {
            pull_page_info_known: true,
            pull_live: true,
        }
    }
}

fn item(event_encoded: GlobalEvent) -> PullItem {
    PullItem {
        event_encoded,
        metadata: None,
    }
}

/// Consumes one scripted failure: `Some(custom)` when one should fire.
fn consume<F: Clone>(failure: &Mutex<(usize, Option<F>)>) -> Option<Option<F>> {
    let mut f = failure.lock().expect("mutex poisoned");
    if f.0 == 0 {
        return None;
    }
    f.0 -= 1;
    Some(f.1.clone())
}
