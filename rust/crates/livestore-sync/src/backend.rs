//! The `SyncBackend` service (`sync/sync-backend.ts`): what a sync provider must implement.

use std::sync::Arc;

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use livestore_core::GlobalEvent;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::watch;

use crate::errors::{ConnectError, PingError, PullError, PushError, UnknownError};

/// `PullResPageInfo`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum PageInfo {
    MoreKnown { remaining: u64 },
    MoreUnknown,
    NoMore,
}

/// One pulled event with its provider metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct PullItem {
    pub event_encoded: GlobalEvent,
    pub metadata: Option<Value>,
}

/// `PullResItem`.
#[derive(Debug, Clone, PartialEq)]
pub struct PullResItem {
    pub batch: Vec<PullItem>,
    pub page_info: PageInfo,
}

impl PullResItem {
    /// `pullResItemEmpty`.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            batch: vec![],
            page_info: PageInfo::NoMore,
        }
    }
}

/// Pull cursor: last seen global sequence number plus the metadata stored with it.
#[derive(Debug, Clone, PartialEq)]
pub struct PullCursor {
    pub event_sequence_number: i64,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PullOptions {
    /// Keep the stream open and emit events pushed after the cursor.
    pub live: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BackendMetadata {
    pub name: String,
    pub description: String,
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Supports {
    pub pull_page_info_known: bool,
    pub pull_live: bool,
}

pub type PullStream = BoxStream<'static, Result<PullResItem, PullError>>;

/// A sync provider client. Futures/streams are `'static` so the leader can run them as tasks;
/// a panic inside them is treated like an Effect defect.
pub trait SyncBackend: Send + Sync + 'static {
    /// Prepares a connection to speed up the first pull/push.
    fn connect(&self) -> BoxFuture<'static, Result<(), ConnectError>>;
    fn pull(&self, cursor: Option<PullCursor>, options: PullOptions) -> PullStream;
    /// Batch constraints: 1-100 events, ascending sequence numbers.
    fn push(&self, batch: Vec<GlobalEvent>) -> BoxFuture<'static, Result<(), PushError>>;
    fn ping(&self) -> BoxFuture<'static, Result<(), PingError>>;
    /// `isConnected: SubscriptionRef<boolean>`.
    fn is_connected(&self) -> watch::Receiver<bool>;
    fn metadata(&self) -> BackendMetadata;
    fn supports(&self) -> Supports;
}

/// Persists the backend id for providers (the TS `KeyValueStore` handed to the constructor).
pub trait BackendIdStore: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, backend_id: &str);
}

/// `MakeBackendArgs`.
#[derive(Clone)]
pub struct MakeBackendArgs {
    pub store_id: String,
    pub client_id: String,
    pub payload: Option<Value>,
    pub backend_id: Arc<dyn BackendIdStore>,
}

/// `SyncBackendConstructor`.
pub type SyncBackendConstructor = Arc<
    dyn Fn(MakeBackendArgs) -> BoxFuture<'static, Result<Arc<dyn SyncBackend>, UnknownError>>
        + Send
        + Sync,
>;

/// Wraps a backend and replaces some of its methods (the TS `{ ...backend, pull: ... }` spread).
pub struct BackendOverride {
    inner: Arc<dyn SyncBackend>,
    pull: Option<PullOverride>,
    push: Option<PushOverride>,
}

type PullOverride =
    Box<dyn Fn(&Arc<dyn SyncBackend>, Option<PullCursor>, PullOptions) -> PullStream + Send + Sync>;
type PushOverride = Box<
    dyn Fn(&Arc<dyn SyncBackend>, Vec<GlobalEvent>) -> BoxFuture<'static, Result<(), PushError>>
        + Send
        + Sync,
>;

impl BackendOverride {
    pub fn new(inner: Arc<dyn SyncBackend>) -> Self {
        Self {
            inner,
            pull: None,
            push: None,
        }
    }

    #[must_use]
    pub fn pull(
        mut self,
        f: impl Fn(&Arc<dyn SyncBackend>, Option<PullCursor>, PullOptions) -> PullStream
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.pull = Some(Box::new(f));
        self
    }

    #[must_use]
    pub fn push(
        mut self,
        f: impl Fn(&Arc<dyn SyncBackend>, Vec<GlobalEvent>) -> BoxFuture<'static, Result<(), PushError>>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.push = Some(Box::new(f));
        self
    }
}

impl SyncBackend for BackendOverride {
    fn connect(&self) -> BoxFuture<'static, Result<(), ConnectError>> {
        self.inner.connect()
    }

    fn pull(&self, cursor: Option<PullCursor>, options: PullOptions) -> PullStream {
        match &self.pull {
            Some(f) => f(&self.inner, cursor, options),
            None => self.inner.pull(cursor, options),
        }
    }

    fn push(&self, batch: Vec<GlobalEvent>) -> BoxFuture<'static, Result<(), PushError>> {
        match &self.push {
            Some(f) => f(&self.inner, batch),
            None => self.inner.push(batch),
        }
    }

    fn ping(&self) -> BoxFuture<'static, Result<(), PingError>> {
        self.inner.ping()
    }

    fn is_connected(&self) -> watch::Receiver<bool> {
        self.inner.is_connected()
    }

    fn metadata(&self) -> BackendMetadata {
        self.inner.metadata()
    }

    fn supports(&self) -> Supports {
        self.inner.supports()
    }
}

/// `SyncBackend.NetworkStatus` without the devtools latch (no devtools in the native client).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetworkStatus {
    pub is_connected: bool,
    pub timestamp_ms: u128,
}

/// `makeNetworkStatusSubscribable`: follows the backend's connectivity, stamping each change.
pub fn network_status(backend: &Arc<dyn SyncBackend>) -> watch::Receiver<NetworkStatus> {
    let mut connected = backend.is_connected();
    let (tx, rx) = watch::channel(NetworkStatus {
        is_connected: *connected.borrow_and_update(),
        timestamp_ms: now_ms(),
    });
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = tx.closed() => return,
                changed = connected.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    let is_connected = *connected.borrow_and_update();
                    tx.send_replace(NetworkStatus { is_connected, timestamp_ms: now_ms() });
                }
            }
        }
    });
    rx
}

/// Builds a [`SyncBackendConstructor`] from an async closure.
pub fn constructor<F, Fut>(f: F) -> SyncBackendConstructor
where
    F: Fn(MakeBackendArgs) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Arc<dyn SyncBackend>, UnknownError>> + Send + 'static,
{
    Arc::new(move |args| Box::pin(f(args)))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}
