//! `ClientSession` and `ClientSessionLeaderThreadProxy`: what an adapter hands the Store.
//! The proxy is a struct of closures so tests can replace single methods, like the TS
//! `leaderThreadProxy: (original) => ({ ...original, events: { ...original.events, push } })` overrides.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use livestore_core::{Event, Payload, SeqNum};
use livestore_sqlite::EventQuery;
use livestore_sync::{LeaderPushError, RejectedPushError, SessionPullItem};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::errors::{Defect, Exit};
use crate::sqlite::SqliteDbWrapper;

/// `LiveStoreEvent.Client.MaterializerHash`.
#[derive(Clone, Debug, PartialEq)]
pub struct MaterializerHash {
    pub event_num: SeqNum,
    pub hash: Option<i64>,
}

/// `ClientSessionLeaderThreadProxy.PullItem`.
#[derive(Clone, Debug, PartialEq)]
pub struct PullItem {
    pub payload: Payload,
    pub global_head: SeqNum,
    pub materializer_hashes: Vec<MaterializerHash>,
}

impl PullItem {
    /// A pull item at the root global head without hashes (the TS tests' `pullItem` helper).
    #[must_use]
    pub fn new(payload: Payload) -> Self {
        Self {
            payload,
            global_head: SeqNum::ROOT,
            materializer_hashes: vec![],
        }
    }
}

impl From<SessionPullItem> for PullItem {
    fn from(item: SessionPullItem) -> Self {
        Self {
            payload: item.payload,
            global_head: item.global_head,
            materializer_hashes: item
                .materializer_hashes
                .into_iter()
                .map(|h| MaterializerHash {
                    event_num: h.event_num,
                    hash: h.hash.map(u64::cast_signed),
                })
                .collect(),
        }
    }
}

/// Failure of `leaderThread.events.push`: a rejection (recoverable by pull), an interrupt, or a defect.
#[derive(Clone, Debug, PartialEq)]
pub enum LeaderPushFailure {
    Rejected(RejectedPushError),
    Interrupted,
    Defect(Defect),
}

impl From<LeaderPushError> for LeaderPushFailure {
    fn from(e: LeaderPushError) -> Self {
        match e {
            LeaderPushError::Rejected(r) => LeaderPushFailure::Rejected(r),
            LeaderPushError::Interrupted => LeaderPushFailure::Interrupted,
        }
    }
}

pub type PushFn =
    Arc<dyn Fn(Vec<Event>) -> BoxFuture<'static, Result<(), LeaderPushFailure>> + Send + Sync>;
pub type PullFn = Arc<dyn Fn(SeqNum) -> BoxStream<'static, Result<PullItem, Defect>> + Send + Sync>;
pub type StreamFn =
    Arc<dyn Fn(EventQuery) -> BoxStream<'static, Result<Event, Defect>> + Send + Sync>;
pub type ShutdownFn = Arc<dyn Fn(Exit) -> BoxFuture<'static, ()> + Send + Sync>;

#[derive(Clone)]
pub struct LeaderThreadProxy {
    pub push: PushFn,
    pub pull: PullFn,
    pub stream: StreamFn,
    /// `initialState.leaderHead`.
    pub leader_head: SeqNum,
    /// `networkStatus` (`isConnected`).
    pub network_status: watch::Receiver<bool>,
}

#[derive(Clone)]
pub struct ClientSession {
    pub sqlite_db: Arc<SqliteDbWrapper>,
    pub client_id: String,
    pub session_id: String,
    pub leader_thread: LeaderThreadProxy,
    pub shutdown: ShutdownFn,
    pub debug_instance_id: String,
}

tokio::task_local! {
    static FINALIZERS: Finalizers;
}

/// Finalizers registered by [`ensuring`] inside an [`interruptible`] call that have not run yet.
#[derive(Clone, Default)]
struct Finalizers(Arc<Mutex<Vec<Registered>>>);

type Registered = (u64, BoxFuture<'static, ()>);

static FINALIZER_IDS: AtomicU64 = AtomicU64::new(0);

/// `Effect.ensuring` for leader calls the session may interrupt (a push): `finalizer` runs once `fut` completes,
/// or, when the call is interrupted, after `fut` is dropped, and the interrupt waits for it.
pub async fn ensuring<T>(
    fut: impl Future<Output = T>,
    finalizer: impl Future<Output = ()> + Send + 'static,
) -> T {
    let Ok(finalizers) = FINALIZERS.try_with(Finalizers::clone) else {
        let out = fut.await;
        finalizer.await;
        return out;
    };
    let id = FINALIZER_IDS.fetch_add(1, Ordering::Relaxed);
    lock(&finalizers.0).push((id, finalizer.boxed()));
    let out = fut.await;
    let finalizer = {
        let mut registered = lock(&finalizers.0);
        registered
            .iter()
            .position(|(i, _)| *i == id)
            .map(|i| registered.remove(i).1)
    };
    if let Some(finalizer) = finalizer {
        finalizer.await;
    }
    out
}

/// Runs `fut` until it completes (`Some`) or `interrupt` fires (`None`); an interrupted `fut` is dropped and the
/// finalizers it registered with [`ensuring`] run before this returns.
pub(crate) async fn interruptible<T>(
    interrupt: CancellationToken,
    fut: impl Future<Output = T>,
) -> Option<T> {
    let finalizers = Finalizers::default();
    let result = tokio::select! {
        biased;
        out = FINALIZERS.scope(finalizers.clone(), fut) => Some(out),
        () = interrupt.cancelled() => None,
    };
    let pending: Vec<_> = std::mem::take(&mut *lock(&finalizers.0));
    for (_, finalizer) in pending.into_iter().rev() {
        finalizer.await;
    }
    result
}

/// Helper for building closures of the proxy.
pub fn push_fn<F, Fut>(f: F) -> PushFn
where
    F: Fn(Vec<Event>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), LeaderPushFailure>> + Send + 'static,
{
    Arc::new(move |batch| Box::pin(f(batch)))
}

pub fn shutdown_fn<F, Fut>(f: F) -> ShutdownFn
where
    F: Fn(Exit) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    Arc::new(move |exit| Box::pin(f(exit)))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
