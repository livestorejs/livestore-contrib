//! Session-level harnesses of the client-session suites: a processor over a scripted leader proxy
//! (`makeClientProcessorHarness`), Effect-style one-shot cells, and the mock-backend store context.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::stream::{BoxStream, StreamExt};
use livestore::processor::{
    Barrier, ClientSessionSyncProcessor, MaterializeEventFn, MaterializeOutput, ProcessorArgs,
    ProcessorParams, RebaseBarrierPoint, StateServices,
};
use livestore::session::{ClientSession, LeaderThreadProxy, PullFn, PushFn, ShutdownFn};
use livestore::sqlite::SqliteDbWrapper;
use livestore::store::ShutdownDeferred;
use livestore::{
    Defect, EventInput, Exit, InMemoryAdapter, PullItem, Store, StoreError, StoreOptions,
    create_store, make_shutdown_deferred,
};
use livestore_core::{Event, Payload, SeqNum};
use livestore_sync::testing::{MockSyncBackend, MockSyncBackendOptions};
use livestore_sync::{OnSyncError, RejectedPushError, SyncOptions};
use tokio::sync::{mpsc, watch};

use super::session;

/// `Deferred`: completes once; later completions are ignored.
pub struct Deferred<T>(Arc<watch::Sender<Option<T>>>);

impl<T> Clone for Deferred<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T: Clone + Send + Sync> Deferred<T> {
    pub fn new() -> Self {
        Self(Arc::new(watch::channel(None).0))
    }

    pub fn succeed(&self, value: T) {
        self.0.send_if_modified(|v| {
            if v.is_some() {
                return false;
            }
            *v = Some(value);
            true
        });
    }

    pub async fn wait(&self) -> T {
        let mut rx = self.0.subscribe();
        rx.wait_for(Option::is_some)
            .await
            .expect("sender held")
            .clone()
            .expect("checked")
    }

    pub fn is_done(&self) -> bool {
        self.0.borrow().is_some()
    }
}

impl Deferred<()> {
    pub fn done(&self) {
        self.succeed(());
    }
}

/// Runs a callback when dropped: an interrupted future's `Effect.ensuring` / `onInterrupt`.
pub struct OnDrop(Option<Box<dyn FnOnce() + Send>>);

impl OnDrop {
    pub fn new(f: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(f)))
    }

    pub fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for OnDrop {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// `Effect.yieldNow`, a few times over so spawned tasks get scheduled.
pub async fn yield_now() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

/// `leaderAheadAtRoot`.
pub fn leader_ahead_at_root() -> RejectedPushError {
    RejectedPushError::LeaderAhead {
        minimum_expected_num: SeqNum::ROOT,
        provided_num: SeqNum::ROOT,
        session_id: "session-test".into(),
    }
}

pub fn ids(events: &[Event]) -> Vec<String> {
    events
        .iter()
        .map(|e| e.args["id"].as_str().unwrap_or_default().to_string())
        .collect()
}

pub fn push<F, Fut>(f: F) -> PushFn
where
    F: Fn(Vec<Event>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), livestore::LeaderPushFailure>> + Send + 'static,
{
    livestore::session::push_fn(f)
}

/// `pullFromQueue`: serves each offered payload as one pull item at the root global head.
pub fn pull_from_queue() -> (mpsc::UnboundedSender<Payload>, PullFn) {
    let (tx, rx) = mpsc::unbounded_channel::<Payload>();
    let rx = Arc::new(tokio::sync::Mutex::new(rx));
    let pull: PullFn = Arc::new(move |_| {
        let rx = rx.clone();
        futures::stream::unfold(rx, |rx| async move {
            let next = rx.lock().await.recv().await;
            next.map(|p| (Ok(PullItem::new(p)), rx))
        })
        .boxed()
    });
    (tx, pull)
}

pub fn advance(new_events: Vec<Event>) -> Payload {
    Payload::UpstreamAdvance { new_events }
}

/// `LiveStoreEvent.Client.Encoded.make` for a `todoCreated` from another client.
pub fn remote_event(id: &str, text: &str, global: i64) -> Event {
    session::encoded(
        "todoCreated",
        serde_json::json!({ "id": id, "text": text, "completed": false }),
        SeqNum::new(global, 0, 0),
        SeqNum::new(global - 1, 0, 0),
        "remote-client",
        "remote-session",
    )
}

/// `makeConflictingUpstream`.
pub fn conflicting_upstream() -> Payload {
    advance(vec![remote_event("remote", "remote", 1)])
}

/// `makeRebaseBarrier`: parks the rebase at a point until released.
pub struct RebaseBarrier {
    pub reached: Deferred<()>,
    pub release: Deferred<()>,
}

impl RebaseBarrier {
    pub fn new() -> Self {
        Self {
            reached: Deferred::new(),
            release: Deferred::new(),
        }
    }

    pub fn effect(&self) -> Barrier {
        let (reached, release) = (self.reached.clone(), self.release.clone());
        Arc::new(move || {
            let (reached, release) = (reached.clone(), release.clone());
            async move {
                reached.done();
                release.wait().await;
            }
            .boxed()
        })
    }
}

pub struct HarnessOptions {
    pub push: PushFn,
    pub pull: PullFn,
    pub shutdown: ShutdownFn,
    pub leader_push_batch_size: usize,
    pub rebase_barriers: HashMap<RebaseBarrierPoint, Barrier>,
    pub materialize_event: MaterializeEventFn,
    pub leader_head: SeqNum,
}

impl HarnessOptions {
    pub fn new(push: PushFn) -> Self {
        Self {
            push,
            pull: Arc::new(|_| futures::stream::empty().boxed()),
            shutdown: Arc::new(|_| async {}.boxed()),
            leader_push_batch_size: 1,
            rebase_barriers: HashMap::new(),
            materialize_event: Arc::new(|_, _| Ok(MaterializeOutput::default())),
            leader_head: SeqNum::ROOT,
        }
    }
}

/// `makeClientProcessorHarness`: a booted processor over an in-memory DB and a scripted leader.
pub struct Harness {
    pub processor: ClientSessionSyncProcessor,
}

impl Harness {
    pub fn new(options: HarnessOptions) -> Self {
        let db = Arc::new(SqliteDbWrapper::open_in_memory().expect("in-memory db"));
        let session = ClientSession {
            sqlite_db: db.clone(),
            client_id: "client-test".into(),
            session_id: "session-test".into(),
            leader_thread: LeaderThreadProxy {
                push: options.push,
                pull: options.pull,
                stream: Arc::new(|_| futures::stream::empty().boxed()),
                leader_head: options.leader_head,
                network_status: watch::channel(true).1,
            },
            shutdown: options.shutdown,
            debug_instance_id: "test-instance".into(),
        };
        let processor = ClientSessionSyncProcessor::new(ProcessorArgs {
            schema: session::schema(),
            client_session: session,
            materialize_event: options.materialize_event,
            refresh_tables: Arc::new(|_| {}),
            state: Arc::new(TestState {
                db,
                head: Mutex::new(SeqNum::ROOT),
            }),
            params: ProcessorParams {
                leader_push_batch_size: options.leader_push_batch_size,
                rebase_barriers: options.rebase_barriers,
            },
        });
        processor.boot();
        Self { processor }
    }

    /// `pushIds`: commits one `todoCreated` per id and returns their pending encodings.
    pub fn push_ids(&self, ids: &[&str]) -> Result<Vec<Event>, StoreError> {
        let events: Vec<EventInput> = ids.iter().map(|id| todo(id)).collect();
        self.processor.commit(events)?;
        Ok(self
            .processor
            .sync_state()
            .pending
            .into_iter()
            .filter(|e| ids.iter().any(|id| e.args["id"] == *id))
            .collect())
    }

    pub async fn close(&self, exit: Exit) -> Exit {
        self.processor.shutdown(exit).await
    }
}

pub fn todo(id: &str) -> EventInput {
    session::TODO_CREATED.make(session::TodoCreated {
        id: id.into(),
        text: id.into(),
        completed: Some(false),
    })
}

/// `StateHead.layerTest` and a journal that records nothing, over real savepoints.
struct TestState {
    db: Arc<SqliteDbWrapper>,
    head: Mutex<SeqNum>,
}

impl StateServices for TestState {
    fn begin_savepoint(&self) -> Result<String, StoreError> {
        Ok(self.db.begin_savepoint()?)
    }

    fn release_savepoint(&self, name: &str) -> Result<(), StoreError> {
        Ok(self.db.release_savepoint(name)?)
    }

    fn rollback_savepoint(&self, name: &str) -> Result<(), StoreError> {
        Ok(self.db.rollback_savepoint(name)?)
    }

    fn set_head(&self, head: SeqNum) -> Result<(), StoreError> {
        *self.head.lock().unwrap() = head;
        Ok(())
    }

    fn journal_rollback(&self, _keys: &[SeqNum]) -> Result<(), StoreError> {
        Ok(())
    }

    fn journal_discard_up_to(&self, _key: SeqNum) -> Result<(), StoreError> {
        Ok(())
    }
}

/// `TestContext`: stores over a shared mock sync backend and one shutdown deferred.
pub struct TestContext {
    pub mock: MockSyncBackend,
    pub shutdown_deferred: ShutdownDeferred,
}

impl TestContext {
    pub fn new() -> Self {
        Self {
            mock: MockSyncBackend::new(MockSyncBackendOptions::default()),
            shutdown_deferred: make_shutdown_deferred(),
        }
    }

    pub fn adapter(&self) -> InMemoryAdapter {
        InMemoryAdapter {
            sync: Some(SyncOptions {
                backend: Some(self.mock.constructor()),
                on_sync_error: OnSyncError::Shutdown,
                ..SyncOptions::default()
            }),
            ..InMemoryAdapter::default()
        }
    }

    pub async fn make_store(
        &self,
        adapter: InMemoryAdapter,
        boot: Option<livestore::store::BootFn>,
    ) -> Store {
        let mut options = StoreOptions::new(session::schema(), adapter.build(), &random_store_id());
        options.shutdown_deferred = Some(self.shutdown_deferred.clone());
        options.boot = boot;
        create_store(options).await.expect("store boots")
    }

    pub async fn shutdown_exit(&self) -> Exit {
        livestore::await_shutdown(&self.shutdown_deferred).await
    }
}

/// `leaderThreadProxy: (leader) => ({ events: { ...leader.events, push } })`.
pub fn with_push(push: PushFn) -> livestore::adapter::ProxyOverride {
    Arc::new(move |proxy| LeaderThreadProxy {
        push: push.clone(),
        ..proxy
    })
}

/// `{ events: { pull, push, stream: () => Stream.empty } }`: a leader the session never reaches.
pub fn scripted_proxy(pull: PullFn, push: PushFn) -> livestore::adapter::ProxyOverride {
    Arc::new(move |proxy| LeaderThreadProxy {
        pull: pull.clone(),
        push: push.clone(),
        stream: Arc::new(|_| futures::stream::empty().boxed()),
        ..proxy
    })
}

/// Waits for the first published state matching `f` (`Stream.filter` + `Stream.take(1)`).
pub async fn wait_for_state(
    changes: &mut BoxStream<'static, livestore_core::SyncState>,
    f: impl Fn(&livestore_core::SyncState) -> bool,
) {
    while let Some(state) = changes.next().await {
        if f(&state) {
            return;
        }
    }
    panic!("sync state changes ended");
}

pub fn defect_of(exit: &Exit) -> Defect {
    exit.as_ref()
        .expect_err("failure exit")
        .as_defect()
        .cloned()
        .expect("a defect")
}

pub fn never<T: Send + 'static>() -> BoxFuture<'static, T> {
    futures::future::pending().boxed()
}

fn random_store_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "store-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}
