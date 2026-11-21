//! `ClientSessionSyncProcessor`: one synchronous owner for local commits, pulled state and propagation
//! decisions, plus an asynchronous runner that does the waiting (leader pushes, pull steps, shutdown).
//!
//! `commit`, each pull step and every message run through `Processor::owned`: the body holds the model
//! lock, never awaits, and queues its notifications and jobs in an outbox that is delivered only after
//! the lock is released (and dropped if the body fails).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::ThreadId;

use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
use livestore_core::{Event, MergeResult, Payload, SeqNum, SyncState, is_equal_encoded, merge};
use livestore_schema::Schema;
use livestore_sync::RejectedPushError;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::field::Empty;
use tracing::{Instrument, Span};

use crate::errors::{Defect, Exit, MaterializeCause, StoreError};
use crate::session::{ClientSession, LeaderPushFailure, PullItem, interruptible};
use crate::sqlite::TableSet;

/// Pulled events applied per reconciliation step before subscribers run and the runner yields.
pub const PULL_CHUNK_SIZE: usize = 32;

/// Placeholder for the session id in event args (TS `SessionIdSymbol`), resolved when encoding.
pub const SESSION_ID_SYMBOL: &str = "__livestore_session_id__";

const REENTRANT_OWNER_MESSAGE: &str = "Reentrant session transition from materialization";

/// `{ name, args }` of an event to commit (`LiveStoreEvent.Input`).
#[derive(Clone, Debug, PartialEq)]
pub struct EventInput {
    pub name: String,
    pub args: Value,
}

impl From<(String, Value)> for EventInput {
    fn from((name, args): (String, Value)) -> Self {
        EventInput { name, args }
    }
}

impl From<&Event> for EventInput {
    fn from(e: &Event) -> Self {
        EventInput {
            name: e.name.clone(),
            args: e.args.clone(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct MaterializeOutput {
    pub write_tables: TableSet,
    pub materializer_hash: Option<i64>,
}

/// Materializes one event and journals it. Must stay synchronous; it does not move the state head.
pub type MaterializeEventFn =
    Arc<dyn Fn(&Event, Option<i64>) -> Result<MaterializeOutput, StoreError> + Send + Sync>;
pub type RefreshTablesFn = Arc<dyn Fn(TableSet) + Send + Sync>;
pub type Barrier = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

/// The state DB services the processor drives (`StateSqliteDb` savepoints, `StateHead`, `MaterializationJournal`).
pub trait StateServices: Send + Sync {
    /// # Errors
    ///
    /// Fails when the state DB rejects the `SAVEPOINT`.
    fn begin_savepoint(&self) -> Result<String, StoreError>;
    /// # Errors
    ///
    /// Fails when no savepoint with that name is open.
    fn release_savepoint(&self, name: &str) -> Result<(), StoreError>;
    /// # Errors
    ///
    /// Fails when no savepoint with that name is open.
    fn rollback_savepoint(&self, name: &str) -> Result<(), StoreError>;
    /// # Errors
    ///
    /// Fails when the state head row cannot be written.
    fn set_head(&self, head: SeqNum) -> Result<(), StoreError>;
    /// # Errors
    ///
    /// Fails when a journaled changeset cannot be read or reverted.
    fn journal_rollback(&self, keys: &[SeqNum]) -> Result<(), StoreError>;
    /// # Errors
    ///
    /// Fails when the journal rows cannot be deleted.
    fn journal_discard_up_to(&self, key: SeqNum) -> Result<(), StoreError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RebaseBarrierPoint {
    BeforeLeaderPushFiberInterrupt,
    BeforeLeaderPushFiberRun,
}

#[derive(Clone)]
pub struct ProcessorParams {
    pub leader_push_batch_size: usize,
    /// Test-only pauses in the async runner, never inside the owner.
    pub rebase_barriers: HashMap<RebaseBarrierPoint, Barrier>,
}

impl Default for ProcessorParams {
    fn default() -> Self {
        Self {
            leader_push_batch_size: 100,
            rebase_barriers: HashMap::new(),
        }
    }
}

pub struct ProcessorArgs {
    pub schema: Arc<Schema>,
    pub client_session: ClientSession,
    pub materialize_event: MaterializeEventFn,
    pub refresh_tables: RefreshTablesFn,
    pub state: Arc<dyn StateServices>,
    pub params: ProcessorParams,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DebugInfo {
    pub rebase_count: u64,
    pub advance_count: u64,
    pub reject_count: u64,
}

/// Cheap to clone handle.
#[derive(Clone)]
pub struct ClientSessionSyncProcessor {
    p: Arc<Processor>,
}

impl ClientSessionSyncProcessor {
    /// # Panics
    ///
    /// Panics when called outside a tokio runtime: the processor keeps that runtime for its tasks.
    #[must_use]
    pub fn new(args: ProcessorArgs) -> Self {
        let leader_head = args.client_session.leader_thread.leader_head;
        let (jobs_tx, jobs_rx) = mpsc::unbounded_channel();
        let (updates_tx, updates_rx) = mpsc::unbounded_channel();
        let p = Processor {
            schema: args.schema,
            session: args.client_session,
            materialize_event: args.materialize_event,
            refresh_tables: args.refresh_tables,
            state: args.state,
            params: args.params,
            model: Mutex::new(Model {
                lifecycle: Lifecycle::Starting,
                sync_state: SyncState {
                    local_head: leader_head,
                    upstream_head: leader_head,
                    pending: vec![],
                },
                push: PushState::Idle { queued: vec![] },
                next_operation_id: 1,
            }),
            owner_thread: Mutex::new(None),
            jobs_tx,
            jobs_rx: Mutex::new(Some(jobs_rx)),
            updates_tx,
            updates_rx: Arc::new(tokio::sync::Mutex::new(updates_rx)),
            shutdown_done: watch::channel(None).0,
            drain_started: watch::channel(false).0,
            rejection_observed: watch::channel(false).0,
            debug: Mutex::new(DebugInfo::default()),
            pending_hashes: Mutex::new(HashMap::new()),
            handles: Mutex::new(Handles::default()),
            escalated: Mutex::new(false),
            runtime: tokio::runtime::Handle::current(),
        };
        Self { p: Arc::new(p) }
    }

    /// Starts the runner and the pull loop.
    ///
    /// # Panics
    ///
    /// Panics when called more than once.
    pub fn boot(&self) {
        let boot = tracing::info_span!("client-session-sync-processor:boot");
        self.p
            .dispatch(Message::Started)
            .expect("starting the processor cannot fail");
        let jobs = lock(&self.p.jobs_rx).take().expect("boot runs once");
        self.p.runtime.spawn(self.p.clone().run_jobs(jobs));
        let pull = tracing::info_span!(parent: &boot, "client-session-sync-processor:pull", "effect.fiber.interrupted" = Empty);
        let p = self.p.clone();
        let mark = MarkInterrupted(Some(pull.clone()));
        let pull = self.p.runtime.spawn(
            async move {
                let mut mark = mark;
                p.pull().await;
                mark.0 = None;
            }
            .instrument(pull),
        );
        let mut handles = lock(&self.p.handles);
        handles.pull = Some(pull);
        handles.boot = Some(boot);
    }

    /// Commits a batch synchronously (encode, merge, materialize in one savepoint) and schedules its push.
    ///
    /// # Errors
    ///
    /// Fails when the processor is shutting down, an event cannot be encoded, or materializing
    /// fails (the savepoint is then rolled back).
    pub fn commit(&self, events: Vec<EventInput>) -> Result<TableSet, StoreError> {
        let _span = tracing::info_span!(
            "client-session-sync-processor:commit",
            batchSize = Empty,
            eventCounts = Empty,
            mergeResultTag = Empty
        )
        .entered();
        self.p.owned(|o| o.commit_local_events(events))
    }

    /// Graceful drain (success exit) or stop (failure exit); resolves with the shutdown result.
    ///
    /// # Errors
    ///
    /// Returns the exit the processor stopped with, or the error when the shutdown request
    /// cannot be recorded.
    pub async fn shutdown(&self, exit: Exit) -> Exit {
        self.begin_shutdown(exit).await
    }

    /// Requests the shutdown now (admission closes before the caller yields) and returns its completion.
    pub(crate) fn begin_shutdown(&self, exit: Exit) -> impl Future<Output = Exit> + Send + use<> {
        let requested = self.p.dispatch(Message::ShutdownRequested { exit });
        let mut done = self.p.shutdown_done.subscribe();
        async move {
            requested?;
            done.wait_for(Option::is_some)
                .await
                .map_or(Ok(()), |v| v.clone().expect("checked"))
        }
    }

    #[must_use]
    pub fn sync_state(&self) -> SyncState {
        lock(&self.p.model).sync_state.clone()
    }

    /// `syncState.changes`: one shared queue of every published state, like `Stream.fromQueue`.
    pub fn sync_state_changes(&self) -> futures::stream::BoxStream<'static, SyncState> {
        let rx = self.p.updates_rx.clone();
        futures::stream::unfold(rx, |rx| async move {
            let next = rx.lock().await.recv().await;
            next.map(|s| (s, rx))
        })
        .boxed()
    }

    #[must_use]
    pub fn debug_info(&self) -> DebugInfo {
        *lock(&self.p.debug)
    }

    pub async fn await_drain_started(&self) {
        let _ = self.p.drain_started.subscribe().wait_for(|v| *v).await;
    }

    pub async fn await_rejection(&self) {
        let _ = self.p.rejection_observed.subscribe().wait_for(|v| *v).await;
    }
}

struct Processor {
    schema: Arc<Schema>,
    session: ClientSession,
    materialize_event: MaterializeEventFn,
    refresh_tables: RefreshTablesFn,
    state: Arc<dyn StateServices>,
    params: ProcessorParams,
    model: Mutex<Model>,
    owner_thread: Mutex<Option<ThreadId>>,
    jobs_tx: mpsc::UnboundedSender<Job>,
    jobs_rx: Mutex<Option<mpsc::UnboundedReceiver<Job>>>,
    updates_tx: mpsc::UnboundedSender<SyncState>,
    updates_rx: Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<SyncState>>>,
    shutdown_done: watch::Sender<Option<Exit>>,
    drain_started: watch::Sender<bool>,
    rejection_observed: watch::Sender<bool>,
    debug: Mutex<DebugInfo>,
    /// Session materializer hashes of pending events, compared with the leader's on confirmation.
    pending_hashes: Mutex<HashMap<String, i64>>,
    handles: Mutex<Handles>,
    escalated: Mutex<bool>,
    /// The runtime that created the store. Tasks spawn on it, so a commit from a thread without tokio works.
    runtime: tokio::runtime::Handle,
}

#[derive(Default)]
struct Handles {
    push: Option<PushTask>,
    pull: Option<JoinHandle<()>>,
    shutdown: Option<JoinHandle<()>>,
    /// `client-session-sync-processor:boot`: parent of the runner's fibers, closed once they are cleared.
    boot: Option<Span>,
}

struct PushTask {
    task: JoinHandle<()>,
    interrupt: CancellationToken,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Reconciliation {
    id: u64,
    rebased: bool,
}

#[derive(Clone, Debug)]
enum Lifecycle {
    Starting,
    Running {
        reconciliation: Option<Reconciliation>,
    },
    ShutdownRequested {
        exit: Exit,
        reconciliation: Option<Reconciliation>,
    },
    Stopping {
        exit: Exit,
    },
    Failed {
        cause: StoreError,
        shutdown_exit: Option<Exit>,
    },
    Stopped,
}

#[derive(Clone, Debug)]
enum PushState {
    Idle {
        queued: Vec<Event>,
    },
    InFlight {
        operation_id: u64,
        batch: Vec<Event>,
        queued: Vec<Event>,
    },
    Cancelling {
        operation_id: u64,
        batch: Vec<Event>,
        queued: Vec<Event>,
    },
    AwaitingReconciliation {
        error: RejectedPushError,
        rejected_events: Vec<Event>,
    },
}

struct Model {
    lifecycle: Lifecycle,
    sync_state: SyncState,
    push: PushState,
    next_operation_id: u64,
}

enum Message {
    Started,
    PullReceived {
        item: PullItem,
        completed: oneshot::Sender<()>,
    },
    PullFinished {
        id: u64,
    },
    PushCancelled {
        operation_id: u64,
    },
    PushSucceeded {
        operation_id: u64,
    },
    PushRejected {
        operation_id: u64,
        error: RejectedPushError,
    },
    PushFailed {
        operation_id: u64,
        cause: StoreError,
    },
    Failed {
        cause: StoreError,
    },
    ShutdownRequested {
        exit: Exit,
    },
    DrainStarted {
        exit: Exit,
    },
    Stopped {
        exit: Exit,
    },
}

enum Job {
    Push {
        operation_id: u64,
        batch: Vec<Event>,
    },
    Reconcile {
        id: u64,
        item: PullItem,
        minimum_end: usize,
        completed: oneshot::Sender<()>,
    },
    BeginShutdown {
        exit: Exit,
    },
    FinishShutdown {
        exit: Exit,
    },
    NotifyFailure {
        cause: StoreError,
    },
}

enum Outbox {
    Job(Job),
    SyncState(SyncState),
    Complete(oneshot::Sender<()>),
    ShutdownDone(Exit),
    DrainStarted,
    RejectionObserved,
}

struct PullStep {
    id: u64,
    payload: Payload,
    last: bool,
    global_head: SeqNum,
    leader_hashes: HashMap<String, Option<i64>>,
}

enum StepResult {
    Applied(TableSet),
    CancelPush(u64),
    Obsolete,
}

/// The owner body's view: the locked model plus its outbox.
struct Owner<'a> {
    p: &'a Processor,
    m: &'a mut Model,
    outbox: Vec<Outbox>,
}

impl Processor {
    fn owned<T>(
        &self,
        body: impl FnOnce(&mut Owner<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let me = std::thread::current().id();
        if *lock(&self.owner_thread) == Some(me) {
            return Err(StoreError::defect(REENTRANT_OWNER_MESSAGE));
        }
        let mut model = lock(&self.model);
        *lock(&self.owner_thread) = Some(me);
        let mut owner = Owner {
            p: self,
            m: &mut model,
            outbox: vec![],
        };
        let result = body(&mut owner).and_then(|v| owner.check_model_invariants().map(|()| v));
        let outbox = std::mem::take(&mut owner.outbox);
        *lock(&self.owner_thread) = None;
        drop(model);
        if result.is_ok() {
            for item in outbox {
                self.deliver(item);
            }
        }
        result
    }

    fn dispatch(&self, message: Message) -> Result<(), StoreError> {
        self.owned(|o| o.transition(message))
    }

    fn deliver(&self, item: Outbox) {
        match item {
            Outbox::Job(job) => _ = self.jobs_tx.send(job),
            Outbox::SyncState(s) => _ = self.updates_tx.send(s),
            Outbox::Complete(tx) => _ = tx.send(()),
            Outbox::ShutdownDone(exit) => {
                self.shutdown_done.send_replace(Some(exit));
            }
            Outbox::DrainStarted => {
                self.drain_started.send_replace(true);
            }
            Outbox::RejectionObserved => {
                self.rejection_observed.send_replace(true);
            }
        }
    }

    fn report_failure(self: &Arc<Self>, cause: StoreError) {
        if let Err(record_error) = self.dispatch(Message::Failed {
            cause: cause.clone(),
        }) {
            self.escalate_unrecorded_failure(cause, &record_error);
        }
    }

    /// Last resort when the owner cannot record a failure: shut down the Store directly.
    fn escalate_unrecorded_failure(&self, cause: StoreError, record_error: &StoreError) {
        let mut escalated = lock(&self.escalated);
        if *escalated {
            return;
        }
        *escalated = true;
        tracing::error!(%cause, %record_error, "Client session sync processor could not record a failure; shutting down the store");
        self.runtime.spawn((self.session.shutdown)(Err(cause)));
    }

    fn report(self: &Arc<Self>, message: Message) {
        if let Err(cause) = self.dispatch(message) {
            self.report_failure(cause);
        }
    }

    async fn run_jobs(self: Arc<Self>, mut jobs: mpsc::UnboundedReceiver<Job>) {
        while !matches!(lock(&self.model).lifecycle, Lifecycle::Stopped) {
            let Some(job) = jobs.recv().await else { break };
            if let Err(cause) = self.run_job(job).await {
                self.report_failure(cause);
            }
        }
    }

    async fn run_job(self: &Arc<Self>, job: Job) -> Result<(), StoreError> {
        match job {
            Job::Push {
                operation_id,
                batch,
            } => self.start_leader_push(operation_id, batch),
            Job::Reconcile {
                id,
                item,
                minimum_end,
                completed,
            } => {
                let boot = lock(&self.handles).boot.clone().unwrap_or_else(Span::none);
                let result = self.reconcile(id, item, minimum_end).instrument(boot).await;
                let _ = completed.send(());
                result?;
            }
            Job::BeginShutdown { exit } => {
                self.clear_pull().await;
                self.dispatch(Message::DrainStarted { exit })?;
            }
            Job::FinishShutdown { exit } => {
                self.clear_pull().await;
                self.clear_push().await;
                drop(lock(&self.handles).boot.take());
                self.dispatch(Message::Stopped { exit })?;
            }
            Job::NotifyFailure { cause } => {
                self.clear_pull().await;
                self.clear_push().await;
                // Store shutdown may call back into this processor; don't block the runner it needs.
                let shutdown = self.runtime.spawn((self.session.shutdown)(Err(cause)));
                lock(&self.handles).shutdown = Some(shutdown);
            }
        }
        Ok(())
    }

    fn start_leader_push(self: &Arc<Self>, operation_id: u64, batch: Vec<Event>) {
        {
            let m = lock(&self.model);
            let current = matches!(&m.push, PushState::InFlight { operation_id: op, .. } if *op == operation_id);
            if !current || !propagates(&m.lifecycle) {
                return;
            }
        }
        let p = self.clone();
        let push = (self.session.leader_thread.push)(batch);
        let boot = lock(&self.handles).boot.clone().unwrap_or_else(Span::none);
        let interrupt = CancellationToken::new();
        let task = self.runtime.spawn(
            interruptible(interrupt.clone(), catch_defect(push))
                .then(move |result| async move {
                    match result {
                        None | Some(Ok(Err(LeaderPushFailure::Interrupted))) => {}
                        Some(Ok(Ok(()))) => p.report(Message::PushSucceeded { operation_id }),
                        Some(Ok(Err(LeaderPushFailure::Rejected(error)))) => {
                            p.report(Message::PushRejected {
                                operation_id,
                                error,
                            });
                        }
                        Some(Ok(Err(LeaderPushFailure::Defect(d))) | Err(d)) => {
                            p.report(Message::PushFailed {
                                operation_id,
                                cause: StoreError::Defect(d),
                            });
                        }
                    }
                })
                .instrument(boot),
        );
        // Like `FiberHandle.run`: the replaced push is interrupted without waiting for its cleanup.
        if let Some(previous) = lock(&self.handles)
            .push
            .replace(PushTask { task, interrupt })
        {
            previous.interrupt.cancel();
        }
    }

    async fn reconcile(
        self: &Arc<Self>,
        id: u64,
        item: PullItem,
        minimum_end: usize,
    ) -> Result<(), StoreError> {
        let leader_hashes: HashMap<String, Option<i64>> = item
            .materializer_hashes
            .iter()
            .map(|h| (h.event_num.to_string(), h.hash))
            .collect();
        let new_events = item.payload.new_events().to_vec();
        let mut offset = 0;
        loop {
            let size = self.step_size(new_events.get(offset));
            let end = (offset + size).max(minimum_end).min(new_events.len());
            let chunk = new_events[offset..end].to_vec();
            let last = end == new_events.len();
            let payload = if offset == 0 {
                match &item.payload {
                    Payload::UpstreamRebase {
                        rollback_events, ..
                    } => Payload::UpstreamRebase {
                        rollback_events: rollback_events.clone(),
                        new_events: chunk.clone(),
                    },
                    _ => Payload::UpstreamAdvance {
                        new_events: chunk.clone(),
                    },
                }
            } else {
                Payload::UpstreamAdvance {
                    new_events: chunk.clone(),
                }
            };
            let step = PullStep {
                id,
                last,
                payload,
                global_head: item.global_head,
                leader_hashes: leader_hashes.clone(),
            };
            match self.owned(|o| o.apply_pull_step(&step))? {
                StepResult::Obsolete => return Ok(()),
                StepResult::CancelPush(operation_id) => {
                    self.barrier(RebaseBarrierPoint::BeforeLeaderPushFiberInterrupt)
                        .await;
                    self.clear_push().await;
                    self.dispatch(Message::PushCancelled { operation_id })?;
                    continue;
                }
                StepResult::Applied(write_tables) => {
                    // The owner is released: subscribers can commit against the completed prefix.
                    if !write_tables.is_empty() {
                        (self.refresh_tables)(write_tables);
                    }
                }
            }
            offset += chunk.len();
            if last {
                break;
            }
            tokio::task::yield_now().await;
        }
        if lock(&self.model)
            .active_reconciliation()
            .is_some_and(|r| r.rebased)
        {
            self.barrier(RebaseBarrierPoint::BeforeLeaderPushFiberRun)
                .await;
        }
        self.dispatch(Message::PullFinished { id })
    }

    /// A step that rebases replays every pending event, so it takes at least as many incoming events.
    fn step_size(&self, first_incoming: Option<&Event>) -> usize {
        let m = lock(&self.model);
        let replays = match (m.sync_state.pending.first(), first_incoming) {
            (Some(oldest), Some(first)) => !is_equal_encoded(first, oldest),
            _ => false,
        };
        if replays {
            PULL_CHUNK_SIZE.max(m.sync_state.pending.len())
        } else {
            PULL_CHUNK_SIZE
        }
    }

    async fn barrier(&self, point: RebaseBarrierPoint) {
        if let Some(barrier) = self.params.rebase_barriers.get(&point) {
            barrier().await;
        }
    }

    async fn pull(self: Arc<Self>) {
        loop {
            let cursor = lock(&self.model).sync_state.upstream_head;
            let mut stream = (self.session.leader_thread.pull)(cursor);
            while let Some(item) = stream.next().await {
                let item = match item {
                    Ok(item) => item,
                    Err(defect) => return self.report_failure(StoreError::Defect(defect)),
                };
                let (completed, done) = oneshot::channel();
                if let Err(cause) = self.dispatch(Message::PullReceived { item, completed }) {
                    return self.report_failure(cause);
                }
                let _ = done.await;
            }
            tokio::task::yield_now().await;
        }
    }

    async fn clear_pull(&self) {
        let handle = lock(&self.handles).pull.take();
        abort_and_wait(handle).await;
    }

    /// `FiberHandle.clear`: interrupts the push and waits until its finalizers ran.
    async fn clear_push(&self) {
        let Some(PushTask { task, interrupt }) = lock(&self.handles).push.take() else {
            return;
        };
        interrupt.cancel();
        let _ = task.await;
    }
}

impl Owner<'_> {
    fn transition(&mut self, message: Message) -> Result<(), StoreError> {
        match message {
            Message::Started => {
                if matches!(self.m.lifecycle, Lifecycle::Starting) {
                    self.m.lifecycle = Lifecycle::Running {
                        reconciliation: None,
                    };
                }
            }
            Message::PullReceived { item, completed } => self.accept_pull(item, completed)?,
            Message::PullFinished { id } => self.finish_pull(id),
            Message::PushCancelled { operation_id } => self.finish_push_cancellation(operation_id),
            Message::PushSucceeded { operation_id } => {
                self.complete_push(operation_id, PushOutcome::Succeeded);
            }
            Message::PushRejected {
                operation_id,
                error,
            } => self.complete_push(operation_id, PushOutcome::Rejected(error)),
            Message::PushFailed {
                operation_id,
                cause,
            } => self.complete_push(operation_id, PushOutcome::Failed(cause)),
            Message::Failed { cause } => self.fail_session(cause),
            Message::ShutdownRequested { exit } => self.request_shutdown(exit),
            Message::DrainStarted { exit } => self.start_drain(exit),
            Message::Stopped { exit } => {
                self.m.lifecycle = Lifecycle::Stopped;
                self.outbox.push(Outbox::ShutdownDone(exit));
            }
        }
        Ok(())
    }

    fn commit_local_events(&mut self, events: Vec<EventInput>) -> Result<TableSet, StoreError> {
        if !matches!(self.m.lifecycle, Lifecycle::Running { .. }) {
            return Err(StoreError::defect(
                "Cannot push events after the client session sync processor starts shutting down",
            ));
        }
        let encoded = tracing::info_span!("client-session-sync-processor:encode-events")
            .in_scope(|| self.encode_events(events))?;
        let result = self.merge(&Payload::LocalPush {
            new_events: encoded.clone(),
        })?;
        let MergeResult::Advance {
            new_sync_state,
            new_events,
            ..
        } = result
        else {
            return Err(StoreError::defect("Expected advance from local-push merge"));
        };
        Span::current()
            .record("batchSize", encoded.len())
            .record("mergeResultTag", "advance")
            .record("eventCounts", event_counts(&encoded).as_str());
        let write_tables = self.in_savepoint(|o| {
            tracing::info_span!("client-session-sync-processor:materialize-events")
                .in_scope(|| o.materialize_events(&encoded))
        })?;
        self.m.sync_state = new_sync_state;
        if let PushState::Idle { queued }
        | PushState::InFlight { queued, .. }
        | PushState::Cancelling { queued, .. } = &mut self.m.push
        {
            queued.extend(new_events);
        }
        self.outbox
            .push(Outbox::SyncState(self.m.sync_state.clone()));
        self.reserve_next_push();
        Ok(write_tables)
    }

    fn accept_pull(
        &mut self,
        item: PullItem,
        completed: oneshot::Sender<()>,
    ) -> Result<(), StoreError> {
        if !matches!(self.m.lifecycle, Lifecycle::Running { .. }) {
            self.outbox.push(Outbox::Complete(completed));
            return Ok(());
        }
        // Validate the whole payload before applying a prefix.
        if let MergeResult::Reject { .. } = self.merge(&item.payload)? {
            return Err(StoreError::defect("Unexpected rejected pull"));
        }
        if self.m.active_reconciliation().is_some() {
            return Err(StoreError::defect("Pull backpressure was bypassed"));
        }
        let id = self.m.next_operation_id;
        let minimum_end = match &item.payload {
            Payload::UpstreamRebase { new_events, .. } => new_events
                .iter()
                .position(|e| {
                    e.seq_num
                        .is_greater_than_or_equal(&self.m.sync_state.upstream_head)
                })
                .map_or(0, |i| i + 1),
            _ => 0,
        };
        self.m.next_operation_id += 1;
        self.m.lifecycle = Lifecycle::Running {
            reconciliation: Some(Reconciliation { id, rebased: false }),
        };
        self.outbox.push(Outbox::Job(Job::Reconcile {
            id,
            item,
            minimum_end,
            completed,
        }));
        Ok(())
    }

    fn apply_pull_step(&mut self, step: &PullStep) -> Result<StepResult, StoreError> {
        let Some(reconciliation) = self.m.active_reconciliation().filter(|r| r.id == step.id)
        else {
            return Ok(StepResult::Obsolete);
        };
        let result = self.merge(&step.payload)?;
        let is_rebase = matches!(result, MergeResult::Rebase { .. });
        match (&result, &self.m.push) {
            (MergeResult::Reject { .. }, _) => {
                return Err(StoreError::defect("Unexpected rejected pull"));
            }
            (
                MergeResult::Rebase { .. },
                PushState::InFlight {
                    operation_id,
                    batch,
                    queued,
                },
            ) => {
                // The push must stop before its batch is rebased; local commits meanwhile land on the old state.
                let operation_id = *operation_id;
                self.m.push = PushState::Cancelling {
                    operation_id,
                    batch: batch.clone(),
                    queued: queued.clone(),
                };
                return Ok(StepResult::CancelPush(operation_id));
            }
            (MergeResult::Rebase { .. }, PushState::Cancelling { .. }) => {
                return Err(StoreError::defect(
                    "Pull step retried before its push cancellation finished",
                ));
            }
            _ => {}
        }
        let span = tracing::info_span!(
            "client-session-sync-processor:apply-pull-step",
            mergeResultTag = merge_result_tag(&result),
            newEvents = result_new_events(&result),
            rollbackEvents = match &result {
                MergeResult::Rebase {
                    rollback_events, ..
                } => rollback_events.len(),
                _ => 0,
            },
        );
        let write_tables =
            span.in_scope(|| self.in_savepoint(|o| o.apply_pull_to_sqlite(&result, step)))?;
        let new_sync_state = match result {
            MergeResult::Advance { new_sync_state, .. }
            | MergeResult::Rebase { new_sync_state, .. } => new_sync_state,
            MergeResult::Reject { .. } => unreachable!("rejected above"),
        };
        if is_rebase {
            self.m.push = PushState::Idle {
                queued: new_sync_state.pending.clone(),
            };
        }
        self.m.sync_state = new_sync_state;
        if is_rebase {
            self.m.set_reconciliation(Some(Reconciliation {
                rebased: true,
                ..reconciliation
            }));
        }
        self.outbox
            .push(Outbox::SyncState(self.m.sync_state.clone()));
        Ok(StepResult::Applied(write_tables))
    }

    fn finish_pull(&mut self, id: u64) {
        let Some(reconciliation) = self.m.active_reconciliation().filter(|r| r.id == id) else {
            return;
        };
        let recovered = matches!(&self.m.push, PushState::AwaitingReconciliation { rejected_events, .. }
            if is_rejected_batch_recovered(rejected_events, &self.m.sync_state.pending));
        if reconciliation.rebased || recovered {
            self.m.push = PushState::Idle {
                queued: self.m.sync_state.pending.clone(),
            };
        }
        self.m.set_reconciliation(None);
        let mut debug = lock(&self.p.debug);
        if reconciliation.rebased {
            debug.rebase_count += 1;
        } else {
            debug.advance_count += 1;
        }
        drop(debug);
        self.reserve_next_push();
    }

    fn finish_push_cancellation(&mut self, operation_id: u64) {
        if let PushState::Cancelling {
            operation_id: op,
            batch,
            queued,
        } = &self.m.push
            && *op == operation_id
        {
            let queued = batch.iter().chain(queued).cloned().collect();
            self.m.push = PushState::Idle { queued };
        }
    }

    fn complete_push(&mut self, operation_id: u64, outcome: PushOutcome) {
        if !propagates(&self.m.lifecycle) {
            return;
        }
        let (current_in_flight, current_any) = match &self.m.push {
            PushState::InFlight {
                operation_id: op, ..
            } => (*op == operation_id, *op == operation_id),
            PushState::Cancelling {
                operation_id: op, ..
            } => (false, *op == operation_id),
            _ => (false, false),
        };
        match outcome {
            PushOutcome::Failed(cause) => {
                // A fatal leader failure still counts while the operation is being cancelled.
                if current_any {
                    self.fail_session(cause);
                }
                return;
            }
            // A cancelling operation's result is superseded by the rebase that cancelled it.
            _ if !current_in_flight => return,
            PushOutcome::Succeeded => {
                if let PushState::InFlight { queued, .. } = &self.m.push {
                    self.m.push = PushState::Idle {
                        queued: queued.clone(),
                    };
                }
            }
            PushOutcome::Rejected(error) => {
                lock(&self.p.debug).reject_count += 1;
                self.outbox.push(Outbox::RejectionObserved);
                let PushState::InFlight { batch, .. } = &self.m.push else {
                    unreachable!("checked in-flight")
                };
                self.m.push = if is_rejected_batch_recovered(batch, &self.m.sync_state.pending) {
                    PushState::Idle {
                        queued: self.m.sync_state.pending.clone(),
                    }
                } else {
                    PushState::AwaitingReconciliation {
                        error,
                        rejected_events: batch.clone(),
                    }
                };
                if let (
                    Lifecycle::Stopping { .. },
                    PushState::AwaitingReconciliation { error, .. },
                ) = (&self.m.lifecycle, &self.m.push)
                {
                    let exit = Err(StoreError::Defect(Defect::new(error.clone())));
                    self.outbox.push(Outbox::Job(Job::FinishShutdown { exit }));
                }
            }
        }
        self.reserve_next_push();
    }

    /// Reserves the next operation before its job becomes visible to the runner.
    fn reserve_next_push(&mut self) {
        if !propagates(&self.m.lifecycle) || self.m.active_reconciliation().is_some() {
            return;
        }
        let PushState::Idle { queued } = &self.m.push else {
            return;
        };
        if queued.is_empty() {
            if matches!(self.m.lifecycle, Lifecycle::Stopping { .. }) {
                self.outbox
                    .push(Outbox::Job(Job::FinishShutdown { exit: Ok(()) }));
            }
            return;
        }
        let operation_id = self.m.next_operation_id;
        let size = self.p.params.leader_push_batch_size.min(queued.len());
        let batch = queued[..size].to_vec();
        let rest = queued[size..].to_vec();
        self.m.next_operation_id += 1;
        self.m.push = PushState::InFlight {
            operation_id,
            batch: batch.clone(),
            queued: rest,
        };
        self.outbox.push(Outbox::Job(Job::Push {
            operation_id,
            batch,
        }));
    }

    fn request_shutdown(&mut self, exit: Exit) {
        match &self.m.lifecycle {
            Lifecycle::Starting | Lifecycle::Running { .. } => {
                // Close admission now, but finish the accepted pull before draining.
                let reconciliation = self.m.active_reconciliation();
                self.m.lifecycle = Lifecycle::ShutdownRequested {
                    exit: exit.clone(),
                    reconciliation,
                };
                self.outbox.push(Outbox::Job(Job::BeginShutdown { exit }));
            }
            Lifecycle::Failed {
                cause,
                shutdown_exit,
            } => {
                if shutdown_exit.is_some() {
                    return;
                }
                let cause = cause.clone();
                let finish = failed_shutdown_exit(&exit, &cause);
                self.m.lifecycle = Lifecycle::Failed {
                    cause,
                    shutdown_exit: Some(exit),
                };
                self.outbox
                    .push(Outbox::Job(Job::FinishShutdown { exit: finish }));
            }
            Lifecycle::ShutdownRequested { .. }
            | Lifecycle::Stopping { .. }
            | Lifecycle::Stopped => {}
        }
    }

    fn start_drain(&mut self, exit: Exit) {
        if let Lifecycle::Failed { cause, .. } = &self.m.lifecycle {
            let finish = failed_shutdown_exit(&exit, cause);
            self.outbox
                .push(Outbox::Job(Job::FinishShutdown { exit: finish }));
            return;
        }
        if !matches!(self.m.lifecycle, Lifecycle::ShutdownRequested { .. }) {
            return;
        }
        let failed = exit.is_err();
        self.m.lifecycle = Lifecycle::Stopping { exit };
        if failed {
            self.outbox
                .push(Outbox::Job(Job::FinishShutdown { exit: Ok(()) }));
            return;
        }
        self.outbox.push(Outbox::DrainStarted);
        if let PushState::AwaitingReconciliation { error, .. } = &self.m.push {
            let exit = Err(StoreError::Defect(Defect::new(error.clone())));
            self.outbox.push(Outbox::Job(Job::FinishShutdown { exit }));
        } else {
            self.reserve_next_push();
        }
    }

    fn fail_session(&mut self, cause: StoreError) {
        match &self.m.lifecycle {
            Lifecycle::Failed { .. } | Lifecycle::Stopped => {}
            Lifecycle::Stopping { exit } => {
                let shutdown_exit = Some(exit.clone());
                self.m.lifecycle = Lifecycle::Failed {
                    cause: cause.clone(),
                    shutdown_exit,
                };
                self.outbox
                    .push(Outbox::Job(Job::FinishShutdown { exit: Err(cause) }));
            }
            lifecycle => {
                // A requested shutdown still finishes through its BeginShutdown job (see start_drain).
                let shutdown_exit = match lifecycle {
                    Lifecycle::ShutdownRequested { exit, .. } => Some(exit.clone()),
                    _ => None,
                };
                self.m.lifecycle = Lifecycle::Failed {
                    cause: cause.clone(),
                    shutdown_exit,
                };
                self.outbox.push(Outbox::Job(Job::NotifyFailure { cause }));
            }
        }
    }

    /// Development check of the propagation bookkeeping that commit and `finish_pull` rely on.
    fn check_model_invariants(&self) -> Result<(), StoreError> {
        let reconciling = self.m.active_reconciliation().is_some();
        if matches!(self.m.push, PushState::Cancelling { .. }) && !reconciling {
            return Err(StoreError::defect(
                "A push can only be cancelled by an active reconciliation",
            ));
        }
        let queued = match &self.m.push {
            PushState::Idle { queued }
            | PushState::InFlight { queued, .. }
            | PushState::Cancelling { queued, .. } => queued,
            PushState::AwaitingReconciliation { .. } => return Ok(()),
        };
        if reconciling || !propagates(&self.m.lifecycle) {
            return Ok(());
        }
        let pending = &self.m.sync_state.pending;
        let is_suffix = pending.len() >= queued.len()
            && queued
                .iter()
                .zip(&pending[pending.len() - queued.len()..])
                .all(|(q, p)| q.seq_num == p.seq_num);
        if is_suffix {
            Ok(())
        } else {
            Err(StoreError::defect(
                "Queued leader pushes must be the unpushed suffix of pending events",
            ))
        }
    }

    fn encode_events(&self, events: Vec<EventInput>) -> Result<Vec<Event>, StoreError> {
        let mut base = self.m.sync_state.local_head;
        let session = &self.p.session;
        events
            .into_iter()
            .map(|EventInput { name, args }| {
                let def = self.p.schema.event(&name).ok_or_else(|| {
                    StoreError::defect(format!("Unknown event definition: {name}"))
                })?;
                let (seq_num, parent_seq_num) =
                    base.next_pair(def.client_only, Some(base.rebase_generation));
                base = seq_num;
                Ok(Event {
                    name,
                    args: resolve_session_id(args, &session.session_id),
                    seq_num,
                    parent_seq_num,
                    client_id: session.client_id.clone(),
                    session_id: session.session_id.clone(),
                })
            })
            .collect()
    }

    fn materialize_events(&mut self, events: &[Event]) -> Result<TableSet, StoreError> {
        let mut write_tables = TableSet::new();
        for event in events {
            let out = (self.p.materialize_event)(event, None)?;
            self.record_pending_hash(event, out.materializer_hash);
            write_tables.extend(out.write_tables);
        }
        // One head write per batch: the savepoint commits the events and the head together.
        if let Some(last) = events.last() {
            self.p.state.set_head(last.seq_num)?;
        }
        Ok(write_tables)
    }

    fn apply_pull_to_sqlite(
        &mut self,
        result: &MergeResult,
        step: &PullStep,
    ) -> Result<TableSet, StoreError> {
        let mut write_tables = TableSet::new();
        let leader_hash_of = |e: &Event| {
            step.leader_hashes
                .get(&e.seq_num.to_string())
                .copied()
                .flatten()
        };
        let mut incoming_by_position: HashMap<(i64, i64), Vec<&Event>> = HashMap::new();
        for e in step.payload.new_events() {
            incoming_by_position
                .entry((e.seq_num.global, e.seq_num.client))
                .or_default()
                .push(e);
        }
        let (new_events, new_sync_state) = match result {
            MergeResult::Advance {
                confirmed_events,
                new_events,
                new_sync_state,
                ..
            } => {
                let mut hashes = lock(&self.p.pending_hashes);
                for event in confirmed_events {
                    let session_hash = hashes.remove(&event.seq_num.to_string());
                    if let (Some(session), Some(leader)) = (session_hash, leader_hash_of(event))
                        && session != leader
                    {
                        return Err(StoreError::Materialize(
                            MaterializeCause::MaterializerHashMismatch {
                                event_name: event.name.clone(),
                            },
                        ));
                    }
                }
                (new_events, new_sync_state)
            }
            MergeResult::Rebase {
                rollback_events,
                new_events,
                new_sync_state,
                ..
            } => {
                let mut hashes = lock(&self.p.pending_hashes);
                for event in rollback_events {
                    hashes.remove(&event.seq_num.to_string());
                }
                drop(hashes);
                let keys: Vec<SeqNum> = rollback_events.iter().map(|e| e.seq_num).collect();
                self.p.state.journal_rollback(&keys)?;
                // Rollback may touch tables absent from the replacement events: refresh all user tables.
                if !rollback_events.is_empty() {
                    write_tables.extend(self.p.schema.tables().iter().map(|t| t.name.clone()));
                }
                (new_events, new_sync_state)
            }
            MergeResult::Reject { .. } => unreachable!("rejected before"),
        };
        for item in new_events {
            // A replayed pending event can temporarily share a sequence number with a later incoming event.
            let incoming = incoming_by_position
                .get(&(item.seq_num.global, item.seq_num.client))
                .is_some_and(|events| events.iter().any(|e| is_equal_encoded(e, item)));
            let out = (self.p.materialize_event)(
                item,
                if incoming { leader_hash_of(item) } else { None },
            )?;
            if !incoming {
                self.record_pending_hash(item, out.materializer_hash);
            }
            write_tables.extend(out.write_tables);
        }
        self.p.state.set_head(new_sync_state.local_head)?;
        if step.last {
            self.p.state.journal_discard_up_to(step.global_head)?;
        }
        Ok(write_tables)
    }

    fn record_pending_hash(&self, event: &Event, hash: Option<i64>) {
        if let Some(hash) = hash {
            lock(&self.p.pending_hashes).insert(event.seq_num.to_string(), hash);
        }
    }

    fn in_savepoint<T>(
        &mut self,
        f: impl FnOnce(&mut Self) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let name = self.p.state.begin_savepoint()?;
        match f(self) {
            Ok(v) => {
                self.p.state.release_savepoint(&name)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.p.state.rollback_savepoint(&name);
                Err(e)
            }
        }
    }

    fn merge(&self, payload: &Payload) -> Result<MergeResult, StoreError> {
        let schema = &self.p.schema;
        merge(
            &self.m.sync_state,
            payload,
            |e| schema.is_client_only(&e.name),
            is_equal_encoded,
            false,
        )
        .map_err(|e| StoreError::defect(e.0))
    }
}

impl Model {
    fn active_reconciliation(&self) -> Option<Reconciliation> {
        match &self.lifecycle {
            Lifecycle::Running { reconciliation }
            | Lifecycle::ShutdownRequested { reconciliation, .. } => *reconciliation,
            _ => None,
        }
    }

    fn set_reconciliation(&mut self, value: Option<Reconciliation>) {
        if let Lifecycle::Running { reconciliation }
        | Lifecycle::ShutdownRequested { reconciliation, .. } = &mut self.lifecycle
        {
            *reconciliation = value;
        }
    }
}

enum PushOutcome {
    Succeeded,
    Rejected(RejectedPushError),
    Failed(StoreError),
}

/// Whether leader pushes may still start or complete.
fn propagates(lifecycle: &Lifecycle) -> bool {
    matches!(
        lifecycle,
        Lifecycle::Running { .. }
            | Lifecycle::ShutdownRequested { .. }
            | Lifecycle::Stopping { .. }
    )
}

/// A shutdown requested with a failure already carries it; otherwise report the session's cause.
fn failed_shutdown_exit(exit: &Exit, cause: &StoreError) -> Exit {
    if exit.is_err() {
        Ok(())
    } else {
        Err(cause.clone())
    }
}

fn merge_result_tag(result: &MergeResult) -> &'static str {
    match result {
        MergeResult::Advance { .. } => "advance",
        MergeResult::Rebase { .. } => "rebase",
        MergeResult::Reject { .. } => "reject",
    }
}

fn result_new_events(result: &MergeResult) -> usize {
    match result {
        MergeResult::Advance { new_events, .. } | MergeResult::Rebase { new_events, .. } => {
            new_events.len()
        }
        MergeResult::Reject { .. } => 0,
    }
}

/// `eventCounts` as TS records it: `JSON.stringify(counts, null, 2)` in first-seen order.
fn event_counts(events: &[Event]) -> String {
    let mut counts: Vec<(&str, usize)> = vec![];
    for e in events {
        match counts.iter_mut().find(|(name, _)| *name == e.name) {
            Some((_, n)) => *n += 1,
            None => counts.push((&e.name, 1)),
        }
    }
    if counts.is_empty() {
        return "{}".into();
    }
    let lines: Vec<String> = counts
        .iter()
        .map(|(name, n)| format!("  {}: {n}", Value::from(*name)))
        .collect();
    format!("{{\n{}\n}}", lines.join(",\n"))
}

/// Records `effect.fiber.interrupted` when the pull task is aborted (dropped before it finished).
struct MarkInterrupted(Option<Span>);

impl Drop for MarkInterrupted {
    fn drop(&mut self) {
        if let Some(span) = &self.0 {
            span.record("effect.fiber.interrupted", true);
        }
    }
}

fn is_rejected_batch_recovered(rejected: &[Event], pending: &[Event]) -> bool {
    rejected
        .iter()
        .all(|r| !pending.iter().any(|p| is_equal_encoded(p, r)))
}

/// `resolveSessionIdSymbolInEventArgs`: replaces [`SESSION_ID_SYMBOL`] values (top level and `id`).
#[must_use]
pub fn resolve_session_id(args: Value, session_id: &str) -> Value {
    match args {
        Value::String(s) if s == SESSION_ID_SYMBOL => Value::String(session_id.into()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, resolve_session_id(v, session_id)))
                .collect(),
        ),
        other => other,
    }
}

/// Runs a leader push, turning a panic inside it into a defect (`Effect.die`).
async fn catch_defect<T>(fut: BoxFuture<'static, T>) -> Result<T, Defect> {
    use futures::FutureExt;
    std::panic::AssertUnwindSafe(fut)
        .catch_unwind()
        .await
        .map_err(|panic| {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| {
                    panic
                        .downcast_ref::<&str>()
                        .map(std::string::ToString::to_string)
                })
                .unwrap_or_else(|| "leader push panicked".into());
            Defect::msg(message)
        })
}

async fn abort_and_wait(handle: Option<JoinHandle<()>>) {
    if let Some(handle) = handle {
        handle.abort();
        let _ = handle.await;
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
