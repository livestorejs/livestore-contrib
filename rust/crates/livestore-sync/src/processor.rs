//! Port of `leader-thread/LeaderSyncProcessor.ts`: one mailbox actor owns the model; local pushes,
//! backend pages, provider results, retries and shutdown all arrive as messages handled one at a time.
//! Provider work runs in spawned tasks that report back through the mailbox; durable work goes
//! through [`LeaderDb`] and only a successful receipt changes observable state.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use futures::{FutureExt, StreamExt};
use livestore_core::syncstate::{self, MergeResult, Payload};
use livestore_core::{Event, SeqNum, SyncState, is_equal_encoded};
use livestore_schema::{MaterializeContext, Schema};
use livestore_sqlite::db::same_position;
use livestore_sqlite::{LeaderDb, PulledEvent, UpstreamCommit};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{AbortHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::Instrument;

use crate::backend::{PageInfo, PullCursor, PullOptions, SyncBackend};
use crate::errors::{
    BackendIdMismatchError, IntentionalShutdownReason, LeaderPushError, PullError, PushError,
    RejectedPushError, ShutdownCause, UnknownError,
};
use crate::leader::InitialSync;
use crate::options::{
    Backoff, OnBackendIdMismatch, OnSyncError, Params, Random, ReconnectWait, Testing,
};
use crate::pull_queue::{MaterializerHash, PullQueueSet, SessionPullItem};

/// Pages a pull may read ahead of the page currently being made durable.
const MAX_PAGES_AHEAD: usize = 16;

pub(crate) type Reply = oneshot::Sender<Result<(), LeaderPushError>>;

pub(crate) enum Msg {
    ContinueWork,
    LocalWorkEnabled,
    LocalPushRequested {
        events: Vec<Event>,
        reply: Reply,
    },
    UpstreamBatchReceived(UpstreamBatch),
    PullCompleted {
        pull_id: u64,
    },
    PullFailed {
        pull_id: u64,
        error: PullError,
    },
    PullRetryElapsed {
        retry_id: u64,
        reconnected: bool,
    },
    PushSucceeded {
        operation_id: u64,
    },
    PushFailed {
        operation_id: u64,
        error: PushError,
        defect: bool,
    },
    PushRetryElapsed {
        retry_id: u64,
    },
    Started,
    ShutdownRequested,
}

pub(crate) struct UpstreamBatch {
    pull_id: u64,
    events: Vec<Event>,
    pulled_events: Vec<PulledEvent>,
    page_info: PageInfo,
    completion: oneshot::Sender<()>,
}

pub(crate) struct Config {
    pub live_pull: bool,
    pub params: Params,
    pub on_sync_error: OnSyncError,
    pub on_backend_id_mismatch: OnBackendIdMismatch,
    pub backoff: Backoff,
}

/// Everything the actor needs; built by [`crate::Leader`] boot.
pub(crate) struct Deps {
    pub schema: Arc<Schema>,
    pub db: Arc<Mutex<LeaderDb>>,
    pub backend: Option<Arc<dyn SyncBackend>>,
    pub config: Config,
    pub testing: Testing,
    pub random: Arc<dyn Random>,
    pub sync_state: watch::Sender<SyncState>,
    pub shutdown: watch::Sender<Option<ShutdownCause>>,
    pub sessions: Arc<PullQueueSet>,
    pub initial_sync: Arc<InitialSync>,
    pub mailbox: mpsc::UnboundedSender<Msg>,
    pub cancel: CancellationToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lifecycle {
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Debug)]
enum PullState {
    Disabled,
    Streaming {
        pull_id: u64,
        more_expected: bool,
        attempt: u32,
    },
    RetryWait {
        retry_id: u64,
        attempt: u32,
    },
    Completed,
}

#[derive(Debug)]
enum PushState {
    Disabled,
    Idle {
        queued: Vec<Event>,
    },
    InFlight {
        operation_id: u64,
        attempt: u32,
        batch: Vec<Event>,
        queued: Vec<Event>,
    },
    RetryWait {
        retry_id: u64,
        attempt: u32,
        batch: Vec<Event>,
        queued: Vec<Event>,
    },
    AwaitingPull {
        queued: Vec<Event>,
    },
}

struct LocalItem {
    request_id: u64,
    event: Event,
}

struct LocalRequest {
    reply: Reply,
    remaining: usize,
}

struct Model {
    lifecycle: Lifecycle,
    sync_state: SyncState,
    pull: PullState,
    push: PushState,
    local_queue: Vec<LocalItem>,
    upstream_queue: Vec<UpstreamBatch>,
    local_work_enabled: bool,
    next_operation_id: u64,
}

pub(crate) struct Processor {
    model: Model,
    d: Deps,
    requests: HashMap<u64, LocalRequest>,
    next_request_id: u64,
    push_task: Option<AbortHandle>,
    pull_task: Option<AbortHandle>,
    background: JoinSet<()>,
    stopped: bool,
}

impl Processor {
    pub fn new(d: Deps, initial: SyncState) -> Self {
        let backend_enabled = d.backend.is_some();
        let schema = d.schema.clone();
        let model = Model {
            lifecycle: Lifecycle::Starting,
            pull: if backend_enabled {
                PullState::Completed
            } else {
                PullState::Disabled
            },
            push: if backend_enabled {
                PushState::Idle {
                    queued: initial
                        .pending
                        .iter()
                        .filter(|e| !schema.is_client_only(&e.name))
                        .cloned()
                        .collect(),
                }
            } else {
                PushState::Disabled
            },
            sync_state: initial,
            local_queue: vec![],
            upstream_queue: vec![],
            local_work_enabled: d.testing.local_push_processing.is_none(),
            next_operation_id: 1,
        };
        Self {
            model,
            d,
            requests: HashMap::new(),
            next_request_id: 1,
            push_task: None,
            pull_task: None,
            background: JoinSet::new(),
            stopped: false,
        }
    }

    /// The mailbox loop: the only consumer, hence the single owner of transition ordering.
    pub async fn run(mut self, mut mailbox: mpsc::UnboundedReceiver<Msg>) {
        if let Some(delay) = self
            .d
            .testing
            .local_push_processing
            .as_ref()
            .and_then(|d| d.lock().expect("mutex poisoned").take())
        {
            let tx = self.d.mailbox.clone();
            self.background.spawn(async move {
                delay.await;
                let _ = tx.send(Msg::LocalWorkEnabled);
            });
        }
        let cancel = self.d.cancel.clone();
        loop {
            let msg = tokio::select! {
                biased;
                () = cancel.cancelled() => Msg::ShutdownRequested,
                msg = mailbox.recv() => msg.unwrap_or(Msg::ShutdownRequested),
            };
            if !self.handle(msg).await {
                break;
            }
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "one match arm per mailbox message, mirroring the TS processor"
    )]
    async fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::ShutdownRequested => return self.stop(Lifecycle::Stopping, None, false),
            Msg::Started => {
                if self.model.lifecycle != Lifecycle::Starting {
                    return true;
                }
                self.model.lifecycle = Lifecycle::Running;
                if self.d.backend.is_some() {
                    self.start_provider_pull(0);
                    self.start_provider_push();
                }
                return true;
            }
            _ if self.model.lifecycle != Lifecycle::Running => return true,
            Msg::LocalPushRequested { events, reply } => {
                // Validating against the tail of the admitted-but-uncommitted queue keeps two callers from
                // being admitted with the same sequence number.
                let push_head = self
                    .model
                    .local_queue
                    .last()
                    .map_or(self.model.sync_state.local_head, |i| i.event.seq_num);
                if let Err(e) = validate_push_batch(&events, push_head, |e| {
                    self.d.schema.is_client_only(&e.name)
                }) {
                    let _ = reply.send(Err(e.into()));
                    return true;
                }
                let request_id = self.next_request_id;
                self.next_request_id += 1;
                self.requests.insert(
                    request_id,
                    LocalRequest {
                        reply,
                        remaining: events.len(),
                    },
                );
                self.model.local_queue.extend(
                    events
                        .iter()
                        .cloned()
                        .map(|event| LocalItem { request_id, event }),
                );
                if let Some(hook) = &self.d.testing.local_push_admitted {
                    hook(events).await;
                }
                self.send(Msg::ContinueWork);
            }
            Msg::LocalWorkEnabled => {
                self.model.local_work_enabled = true;
                self.send(Msg::ContinueWork);
            }
            Msg::ContinueWork => return self.process_next_work(),
            Msg::UpstreamBatchReceived(batch) => {
                if let Some(hook) = &self.d.testing.upstream_batch_received {
                    hook(batch.events.clone()).await;
                }
                let PullState::Streaming {
                    pull_id,
                    more_expected,
                    ..
                } = &mut self.model.pull
                else {
                    let _ = batch.completion.send(());
                    return true;
                };
                if *pull_id != batch.pull_id {
                    // A late page from an old pull is released but must not change the model.
                    let _ = batch.completion.send(());
                    return true;
                }
                // Any response, including an empty page, proves backend contact.
                self.model.pull = PullState::Streaming {
                    pull_id: batch.pull_id,
                    more_expected: if batch.events.is_empty() {
                        *more_expected && batch.page_info != PageInfo::NoMore
                    } else {
                        batch.page_info != PageInfo::NoMore
                    },
                    attempt: 0,
                };
                if batch.events.is_empty() {
                    let _ = batch.completion.send(());
                } else {
                    self.model.upstream_queue.push(batch);
                }
                self.send(Msg::ContinueWork);
            }
            Msg::PullCompleted { pull_id } => {
                if matches!(self.model.pull, PullState::Streaming { pull_id: p, .. } if p == pull_id)
                {
                    self.model.pull = PullState::Completed;
                    self.send(Msg::ContinueWork);
                }
            }
            Msg::PullFailed { pull_id, error } => {
                let PullState::Streaming {
                    pull_id: current,
                    attempt,
                    ..
                } = self.model.pull
                else {
                    return true;
                };
                if current != pull_id {
                    return true;
                }
                match error {
                    PullError::IsOffline(_) => {
                        let retry_id = self.allocate_operation_id();
                        let attempt = attempt + 1;
                        self.model.pull = PullState::RetryWait { retry_id, attempt };
                        let wait = self.await_pull_retry(attempt);
                        let tx = self.d.mailbox.clone();
                        self.background.spawn(async move {
                            let reconnected = wait.await;
                            let _ = tx.send(Msg::PullRetryElapsed {
                                retry_id,
                                reconnected,
                            });
                        });
                    }
                    PullError::BackendIdMismatch(e) => {
                        return self.handle_backend_mismatch(e, Direction::Pull);
                    }
                    PullError::Unknown(e)
                        if self.d.config.on_sync_error == OnSyncError::Shutdown =>
                    {
                        return self.stop(
                            Lifecycle::Failed,
                            Some(ShutdownCause::UnknownError(e)),
                            true,
                        );
                    }
                    PullError::Unknown(_) => {
                        self.model.pull = PullState::Completed;
                        self.send(Msg::ContinueWork);
                    }
                }
            }
            Msg::PullRetryElapsed {
                retry_id,
                reconnected,
            } => {
                if let PullState::RetryWait {
                    retry_id: current,
                    attempt,
                } = self.model.pull
                    && current == retry_id
                {
                    // A reconnect proves the backend is reachable again: the next outage starts from the shortest delay.
                    self.start_provider_pull(if reconnected { 0 } else { attempt });
                }
            }
            Msg::PushSucceeded { operation_id } => {
                if let PushState::InFlight {
                    operation_id: current,
                    queued,
                    ..
                } = &mut self.model.push
                    && *current == operation_id
                {
                    self.model.push = PushState::Idle {
                        queued: std::mem::take(queued),
                    };
                    self.start_provider_push();
                }
            }
            Msg::PushFailed {
                operation_id,
                error,
                defect,
            } => {
                let PushState::InFlight {
                    operation_id: current,
                    attempt,
                    batch,
                    queued,
                } = &mut self.model.push
                else {
                    return true;
                };
                if *current != operation_id {
                    return true;
                }
                let (attempt, batch, queued) =
                    (*attempt, std::mem::take(batch), std::mem::take(queued));
                match error {
                    PushError::ServerAhead(_) => {
                        // Pulling first will confirm or rebase these events; don't retry the stale batch until then.
                        self.model.push = PushState::AwaitingPull {
                            queued: batch.into_iter().chain(queued).collect(),
                        };
                        return true;
                    }
                    PushError::BackendIdMismatch(e) => {
                        return self.handle_backend_mismatch(e, Direction::Push);
                    }
                    // A defect is not a provider error: like a failed pull it follows `onSyncError`.
                    PushError::Unknown(e)
                        if defect && self.d.config.on_sync_error == OnSyncError::Shutdown =>
                    {
                        return self.stop(
                            Lifecycle::Failed,
                            Some(ShutdownCause::UnknownError(e)),
                            true,
                        );
                    }
                    _ => {}
                }
                let retry_id = self.allocate_operation_id();
                let attempt = attempt + 1;
                self.model.push = PushState::RetryWait {
                    retry_id,
                    attempt,
                    batch,
                    queued,
                };
                let (tx, delay) = (self.d.mailbox.clone(), self.d.config.backoff.delay(attempt));
                self.background.spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = tx.send(Msg::PushRetryElapsed { retry_id });
                });
            }
            Msg::PushRetryElapsed { retry_id } => {
                if let PushState::RetryWait {
                    retry_id: current,
                    attempt,
                    batch,
                    queued,
                } = &mut self.model.push
                    && *current == retry_id
                {
                    let (attempt, batch, queued) =
                        (*attempt, std::mem::take(batch), std::mem::take(queued));
                    self.run_push_operation(attempt, batch, queued);
                }
            }
        }
        true
    }

    fn process_next_work(&mut self) -> bool {
        if self.model.lifecycle != Lifecycle::Running {
            return true;
        }
        // Apply backend truth before more local work, so local events are never numbered on a stale head.
        if !self.model.upstream_queue.is_empty() {
            let first = self.model.upstream_queue[0].pull_id;
            let n = self
                .model
                .upstream_queue
                .iter()
                .position(|b| b.pull_id != first)
                .unwrap_or(self.model.upstream_queue.len());
            let pages: Vec<UpstreamBatch> = self.model.upstream_queue.drain(..n).collect();
            return self.process_upstream_batch(pages);
        }
        // Pages announcing more pages describe one uninterrupted advance: keep local work paused until it ends.
        if matches!(
            self.model.pull,
            PullState::Streaming {
                more_expected: true,
                ..
            }
        ) {
            return true;
        }
        if !self.model.local_work_enabled || self.model.local_queue.is_empty() {
            return true;
        }
        let n = self
            .d
            .config
            .params
            .local_push_batch_size
            .min(self.model.local_queue.len());
        let generation = self.model.sync_state.local_head.rebase_generation;
        let (stale, active): (Vec<LocalItem>, Vec<LocalItem>) = self
            .model
            .local_queue
            .drain(..n)
            .partition(|i| i.event.seq_num.rebase_generation < generation);
        if !stale.is_empty() {
            for item in &stale {
                let error = RejectedPushError::StaleRebaseGeneration {
                    current_rebase_generation: generation,
                    provided_rebase_generation: item.event.seq_num.rebase_generation,
                    session_id: item.event.session_id.clone(),
                };
                self.reject(item.request_id, error);
            }
            self.model.local_queue.splice(0..0, active);
            self.send(Msg::ContinueWork);
            return true;
        }
        self.process_local_batch(&active)
    }

    fn process_local_batch(&mut self, items: &[LocalItem]) -> bool {
        let span = tracing::debug_span!(
            "@livestore/common:LeaderSyncProcessor:processLocalBatch",
            batch_size = items.len()
        );
        let _guard = span.enter();
        let payload = Payload::LocalPush {
            new_events: items.iter().map(|i| i.event.clone()).collect(),
        };
        let merge = match self.merge(&payload, false) {
            Ok(m) => m,
            Err(e) => {
                return self
                    .stop_for_sync_failure(ShutdownCause::UnknownError(UnknownError::new(e)));
            }
        };
        let new_sync_state = match merge {
            MergeResult::Reject {
                expected_minimum_id,
                ..
            } => {
                // Later events of the same generation were numbered on top of this batch: reject them together.
                let generation = items[0].event.seq_num.rebase_generation;
                let first = &items[0].event;
                let error = RejectedPushError::LeaderAhead {
                    minimum_expected_num: expected_minimum_id,
                    provided_num: first.seq_num,
                    session_id: first.session_id.clone(),
                };
                let (same_gen, rest): (Vec<LocalItem>, Vec<LocalItem>) =
                    std::mem::take(&mut self.model.local_queue)
                        .into_iter()
                        .partition(|i| i.event.seq_num.rebase_generation == generation);
                self.model.local_queue = rest;
                for item in items.iter().chain(&same_gen) {
                    self.reject(item.request_id, error.clone());
                }
                self.send(Msg::ContinueWork);
                return true;
            }
            MergeResult::Rebase { .. } => {
                return self.stop_for_sync_failure(unknown("Local push required rebase"));
            }
            MergeResult::Advance {
                new_sync_state,
                new_events,
                ..
            } => {
                let events = &new_sync_state.pending[self
                    .model
                    .sync_state
                    .pending
                    .len()
                    .min(new_sync_state.pending.len())..];
                if events.len() != new_events.len() {
                    return self
                        .stop_for_sync_failure(unknown("Local push was not retained as pending"));
                }
                new_sync_state
            }
        };
        let events = new_sync_state.pending[self.model.sync_state.pending.len()..].to_vec();
        let persisted = self
            .d
            .db
            .lock()
            .expect("mutex poisoned")
            .persist_local(&events);
        let receipt = match persisted {
            Ok(r) => r,
            Err(e) => return self.stop_for_sync_failure(ShutdownCause::from_storage(&e)),
        };
        if receipt.state_head != new_sync_state.local_head {
            return self.stop_for_sync_failure(unknown(&format!(
                "PersistReceiptMismatch: expected {}, got {}",
                new_sync_state.local_head, receipt.state_head
            )));
        }
        let to_push: Vec<Event> = receipt
            .persisted_events
            .iter()
            .filter(|e| !self.d.schema.is_client_only(&e.name))
            .cloned()
            .collect();
        self.publish(
            new_sync_state,
            Payload::UpstreamAdvance {
                new_events: receipt.persisted_events,
            },
        );
        match &mut self.model.push {
            PushState::Disabled => {}
            PushState::Idle { queued }
            | PushState::InFlight { queued, .. }
            | PushState::RetryWait { queued, .. }
            | PushState::AwaitingPull { queued } => queued.extend(to_push),
        }
        self.start_provider_push();
        self.complete(items);
        self.send(Msg::ContinueWork);
        true
    }

    fn process_upstream_batch(&mut self, pages: Vec<UpstreamBatch>) -> bool {
        let events: Vec<Event> = pages
            .iter()
            .flat_map(|p| p.events.iter().cloned())
            .collect();
        let pulled: Vec<PulledEvent> = pages
            .iter()
            .flat_map(|p| p.pulled_events.iter().cloned())
            .collect();
        let span = tracing::debug_span!(
            "@livestore/common:LeaderSyncProcessor:processUpstreamBatch",
            batch_size = events.len()
        );
        let _guard = span.enter();
        let merge = match self.merge(
            &Payload::UpstreamAdvance {
                new_events: events.clone(),
            },
            true,
        ) {
            Ok(m) => m,
            Err(e) => {
                return self
                    .stop_for_sync_failure(ShutdownCause::UnknownError(UnknownError::new(e)));
            }
        };
        let (new_sync_state, new_events, rollback, confirmed, is_rebase) = match merge {
            MergeResult::Reject { .. } => {
                return self.stop_for_sync_failure(unknown("Upstream batch rejected"));
            }
            MergeResult::Rebase {
                new_sync_state,
                new_events,
                rollback_events,
                ..
            } => (new_sync_state, new_events, rollback_events, vec![], true),
            MergeResult::Advance {
                new_sync_state,
                new_events,
                confirmed_events,
                ..
            } => (new_sync_state, new_events, vec![], confirmed_events, false),
        };
        let Some(backend_head) = events.last().map(|e| e.seq_num) else {
            return self.stop_for_sync_failure(unknown("Upstream batch has no head"));
        };
        let commit = UpstreamCommit {
            pulled_events: &pulled,
            events: &new_events,
            rollback_events: &rollback,
            confirmed_events: &confirmed,
            backend_head,
        };
        let persisted = self
            .d
            .db
            .lock()
            .expect("mutex poisoned")
            .persist_upstream(&commit);
        let receipt = match persisted {
            Ok(r) => r,
            Err(e) => return self.stop_for_sync_failure(ShutdownCause::from_storage(&e)),
        };
        // Confirming a pending event rebased locally keeps the higher generation: compare positions only.
        if !same_position(receipt.state_head, new_sync_state.local_head)
            || receipt.backend_head != Some(backend_head)
        {
            return self.stop_for_sync_failure(unknown("PersistReceiptMismatch"));
        }
        let payload = if is_rebase {
            Payload::UpstreamRebase {
                rollback_events: rollback,
                new_events: receipt.persisted_events,
            }
        } else {
            Payload::UpstreamAdvance {
                new_events: receipt.persisted_events,
            }
        };
        let replacement: Vec<Event> = new_sync_state
            .pending
            .iter()
            .filter(|e| !self.d.schema.is_client_only(&e.name))
            .cloned()
            .collect();
        self.publish(new_sync_state, payload);
        for page in pages {
            let _ = page.completion.send(());
        }
        self.replace_push_plan(replacement);
        self.send(Msg::ContinueWork);
        true
    }

    fn handle_backend_mismatch(
        &mut self,
        error: BackendIdMismatchError,
        direction: Direction,
    ) -> bool {
        match self.d.config.on_backend_id_mismatch {
            OnBackendIdMismatch::Ignore => {
                match direction {
                    Direction::Pull => {
                        self.model.pull = PullState::Completed;
                        self.send(Msg::ContinueWork);
                    }
                    Direction::Push => self.model.push = PushState::Disabled,
                }
                true
            }
            OnBackendIdMismatch::Shutdown => {
                tracing::warn!(%error, "Sync backend identity changed (backend was reset). Shutting down without clearing local storage.");
                self.stop(
                    Lifecycle::Failed,
                    Some(ShutdownCause::BackendIdMismatchError(error)),
                    true,
                )
            }
            OnBackendIdMismatch::Reset => {
                tracing::warn!(%error, "Sync backend identity changed (backend was reset). Clearing local storage and shutting down.");
                // Stop all work that could still touch the databases before clearing them.
                self.model.lifecycle = Lifecycle::Stopping;
                self.interrupt_all_work();
                let cleared = self.d.db.lock().expect("mutex poisoned").clear_for_reset();
                let cause = match cleared {
                    Ok(()) => ShutdownCause::IntentionalShutdownCause(
                        IntentionalShutdownReason::BackendIdMismatch,
                    ),
                    Err(e) => ShutdownCause::UnknownError(UnknownError::with_note(
                        e,
                        "Failed to reset local databases after backend mismatch",
                    )),
                };
                self.stop(Lifecycle::Failed, Some(cause), true)
            }
        }
    }

    fn start_provider_push(&mut self) {
        if self.model.lifecycle != Lifecycle::Running {
            return;
        }
        let PushState::Idle { queued } = &mut self.model.push else {
            return;
        };
        if queued.is_empty() {
            return;
        }
        let mut queued = std::mem::take(queued);
        let batch: Vec<Event> = queued
            .drain(
                ..self
                    .d
                    .config
                    .params
                    .backend_push_batch_size
                    .min(queued.len()),
            )
            .collect();
        self.run_push_operation(0, batch, queued);
    }

    fn run_push_operation(&mut self, attempt: u32, batch: Vec<Event>, queued: Vec<Event>) {
        let Some(backend) = self.d.backend.clone() else {
            return;
        };
        let operation_id = self.allocate_operation_id();
        let global: Vec<_> = batch.iter().map(Event::to_global).collect();
        self.model.push = PushState::InFlight {
            operation_id,
            attempt,
            batch,
            queued,
        };
        let tx = self.d.mailbox.clone();
        let task = async move {
            let result = AssertUnwindSafe(async {
                let _ = backend.is_connected().wait_for(|c| *c).await;
                tracing::debug!(batch_size = global.len(), "backend-push");
                backend.push(global).await
            })
            .catch_unwind()
            .await;
            let msg = match result {
                Ok(Ok(())) => Msg::PushSucceeded { operation_id },
                Ok(Err(error)) => {
                    tracing::debug!(%error, retries = attempt, "backend-push-error");
                    Msg::PushFailed {
                        operation_id,
                        error,
                        defect: false,
                    }
                }
                Err(panic) => Msg::PushFailed {
                    operation_id,
                    error: UnknownError::with_note(
                        panic_message(&*panic),
                        "Sync backend push defected",
                    )
                    .into(),
                    defect: true,
                },
            };
            let _ = tx.send(msg);
        };
        if let Some(old) = self.push_task.replace(tokio::spawn(task).abort_handle()) {
            old.abort();
        }
    }

    fn start_provider_pull(&mut self, attempt: u32) {
        let Some(backend) = self.d.backend.clone() else {
            return;
        };
        if self.model.lifecycle != Lifecycle::Running {
            return;
        }
        let pull_id = self.allocate_operation_id();
        self.model.pull = PullState::Streaming {
            pull_id,
            more_expected: false,
            attempt,
        };
        let (tx, db, live, initial_sync) = (
            self.d.mailbox.clone(),
            self.d.db.clone(),
            self.d.config.live_pull,
            self.d.initial_sync.clone(),
        );
        let upstream_head = self.model.sync_state.upstream_head.global;
        let task = async move {
            // Pages handed to the mailbox but not yet durable; a full queue is the stream's backpressure.
            let (outstanding_tx, mut outstanding_rx) =
                mpsc::channel::<(oneshot::Receiver<()>, usize, PageInfo)>(MAX_PAGES_AHEAD);
            let mut progress = AbortOnDrop(tokio::spawn(async move {
                while let Some((completion, processed, page_info)) = outstanding_rx.recv().await {
                    if completion.await.is_err() {
                        return;
                    }
                    initial_sync.update(processed, &page_info);
                }
            }));
            let result = AssertUnwindSafe(async {
                let cursor = db
                    .lock()
                    .expect("mutex poisoned")
                    .cursor_info(upstream_head)
                    .map_err(UnknownError::new)?;
                let cursor = cursor.map(|c| PullCursor {
                    event_sequence_number: c.event_sequence_number,
                    metadata: c.metadata,
                });
                let mut stream = backend.pull(cursor, PullOptions { live });
                while let Some(item) = stream.next().await {
                    let item = item?;
                    let _ = backend.is_connected().wait_for(|c| *c).await;
                    let (completion, done) = oneshot::channel();
                    let pulled_events: Vec<PulledEvent> = item
                        .batch
                        .into_iter()
                        .map(|i| PulledEvent {
                            event: i.event_encoded.into(),
                            sync_metadata: i.metadata,
                        })
                        .collect();
                    let processed = pulled_events.len();
                    let events = pulled_events.iter().map(|p| p.event.clone()).collect();
                    let page_info = item.page_info;
                    let _ = tx.send(Msg::UpstreamBatchReceived(UpstreamBatch {
                        pull_id,
                        events,
                        pulled_events,
                        page_info: page_info.clone(),
                        completion,
                    }));
                    let _ = outstanding_tx.send((done, processed, page_info)).await;
                    tokio::task::yield_now().await;
                }
                Ok::<(), PullError>(())
            })
            .catch_unwind()
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => _ = tx.send(Msg::PullFailed { pull_id, error }),
                Err(panic) => {
                    let error = UnknownError::with_note(
                        panic_message(&*panic),
                        "Sync backend pull defected",
                    )
                    .into();
                    let _ = tx.send(Msg::PullFailed { pull_id, error });
                }
            }
            // Pages sent before a failure are still applied: keep reporting their progress (initial sync).
            drop(outstanding_tx);
            let _ = (&mut progress.0).await;
            let _ = tx.send(Msg::PullCompleted { pull_id });
        }
        .instrument(tracing::debug_span!(
            "@livestore/common:LeaderSyncProcessor:backend-pulling"
        ));
        if let Some(old) = self.pull_task.replace(tokio::spawn(task).abort_handle()) {
            old.abort();
        }
    }

    /// Waits before retrying an offline pull: a false→true connectivity transition wakes it early, a
    /// jittered capped fallback timer covers connectivity that stays stale-true. Resolves `true` on reconnect.
    fn await_pull_retry(&self, attempt: u32) -> impl Future<Output = bool> + Send + 'static {
        let jittered = self
            .d
            .config
            .backoff
            .delay(attempt)
            .mul_f64(self.d.random.next_between(0.8, 1.2));
        let fallback = self
            .d
            .testing
            .backend_pull_reconnect
            .as_ref()
            .map_or(jittered, |f| f(jittered));
        let backend = self.d.backend.clone();
        let hook = self.d.testing.backend_pull_reconnect_wait.clone();
        async move {
            let Some(backend) = backend else {
                tokio::time::sleep(fallback).await;
                return false;
            };
            let mut rx = backend.is_connected();
            let observe = async {
                let mut first = true;
                let mut seen_false = false;
                loop {
                    if !first && rx.changed().await.is_err() {
                        return std::future::pending().await;
                    }
                    first = false;
                    let is_connected = *rx.borrow_and_update();
                    if let Some(hook) = &hook {
                        hook(ReconnectWait {
                            is_connected,
                            fallback,
                        })
                        .await;
                    }
                    if !is_connected {
                        seen_false = true;
                    } else if seen_false {
                        return true;
                    }
                }
            };
            tokio::time::timeout(fallback, observe)
                .await
                .unwrap_or(false)
        }
    }

    fn replace_push_plan(&mut self, replacement: Vec<Event>) {
        if matches!(self.model.push, PushState::Disabled) {
            return;
        }
        // A rebase may have changed every pending number: rebuild the plan from the committed state.
        let in_flight = matches!(self.model.push, PushState::InFlight { .. });
        self.model.push = PushState::Idle {
            queued: replacement,
        };
        if in_flight && let Some(task) = self.push_task.take() {
            task.abort();
        }
        self.start_provider_push();
    }

    fn publish(&mut self, sync_state: SyncState, payload: Payload) {
        let (local_head, global_head) = (sync_state.local_head, sync_state.upstream_head);
        self.model.sync_state = sync_state.clone();
        self.d.sync_state.send_replace(sync_state);
        let materializer_hashes = materializer_hashes(&self.d.schema, payload.new_events());
        self.d.sessions.offer(
            local_head,
            SessionPullItem {
                payload,
                global_head,
                materializer_hashes,
            },
        );
    }

    fn stop_for_sync_failure(&mut self, cause: ShutdownCause) -> bool {
        tracing::warn!(%cause, "leader sync failure");
        let notify = self.d.config.on_sync_error == OnSyncError::Shutdown;
        self.stop(Lifecycle::Failed, Some(cause), notify)
    }

    /// Always returns `false` (ends the mailbox loop).
    fn stop(&mut self, lifecycle: Lifecycle, error: Option<ShutdownCause>, notify: bool) -> bool {
        if self.stopped {
            return false;
        }
        self.model.lifecycle = lifecycle;
        if notify && let Some(error) = error {
            self.d.shutdown.send_replace(Some(error));
        }
        self.interrupt_all_work();
        self.stopped = true;
        false
    }

    /// Aborts provider/background tasks; dropping replies interrupts admitted pushes.
    fn interrupt_all_work(&mut self) {
        for task in [self.push_task.take(), self.pull_task.take()]
            .into_iter()
            .flatten()
        {
            task.abort();
        }
        self.background.abort_all();
        self.requests.clear();
        self.model.upstream_queue.clear();
    }

    fn merge(
        &self,
        payload: &Payload,
        ignore_client_only: bool,
    ) -> Result<MergeResult, syncstate::MergeError> {
        let schema = &self.d.schema;
        syncstate::merge(
            &self.model.sync_state,
            payload,
            |e| schema.is_client_only(&e.name),
            is_equal_encoded,
            ignore_client_only,
        )
    }

    fn complete(&mut self, items: &[LocalItem]) {
        for item in items {
            let Some(request) = self.requests.get_mut(&item.request_id) else {
                continue;
            };
            request.remaining -= 1;
            if request.remaining == 0
                && let Some(request) = self.requests.remove(&item.request_id)
            {
                let _ = request.reply.send(Ok(()));
            }
        }
    }

    fn reject(&mut self, request_id: u64, error: RejectedPushError) {
        if let Some(request) = self.requests.remove(&request_id) {
            let _ = request.reply.send(Err(error.into()));
        }
    }

    fn allocate_operation_id(&mut self) -> u64 {
        let id = self.model.next_operation_id;
        self.model.next_operation_id += 1;
        id
    }

    fn send(&self, msg: Msg) {
        let _ = self.d.mailbox.send(msg);
    }
}

#[derive(Clone, Copy)]
enum Direction {
    Pull,
    Push,
}

/// `validatePushBatch`: strictly increasing, ahead of the push head, current generation, one unbroken chain.
pub(crate) fn validate_push_batch(
    batch: &[Event],
    push_head: SeqNum,
    is_client_only: impl Fn(&Event) -> bool,
) -> Result<(), RejectedPushError> {
    let Some(first) = batch.first() else {
        return Ok(());
    };
    for (i, w) in batch.windows(2).enumerate() {
        if w[0].seq_num.is_greater_than_or_equal(&w[1].seq_num) {
            return Err(RejectedPushError::NonMonotonicBatch {
                preceding_seq_num: w[0].seq_num,
                violating_seq_num: w[1].seq_num,
                violation_index: i + 1,
                session_id: w[1].session_id.clone(),
            });
        }
    }
    if push_head.is_greater_than_or_equal(&first.seq_num) {
        return Err(RejectedPushError::LeaderAhead {
            minimum_expected_num: push_head,
            provided_num: first.seq_num,
            session_id: first.session_id.clone(),
        });
    }
    if first.seq_num.rebase_generation < push_head.rebase_generation {
        return Err(RejectedPushError::StaleRebaseGeneration {
            current_rebase_generation: push_head.rebase_generation,
            provided_rebase_generation: first.seq_num.rebase_generation,
            session_id: first.session_id.clone(),
        });
    }
    let mut preceding = push_head;
    for (i, event) in batch.iter().enumerate() {
        let (seq_num, parent) =
            preceding.next_pair(is_client_only(event), Some(event.seq_num.rebase_generation));
        if event.seq_num != seq_num || !same_position(event.parent_seq_num, parent) {
            return Err(RejectedPushError::NonContiguousBatch {
                expected_seq_num: seq_num,
                provided_seq_num: event.seq_num,
                expected_parent_seq_num: parent,
                provided_parent_seq_num: event.parent_seq_num,
                violation_index: i,
                session_id: event.session_id.clone(),
            });
        }
        preceding = event.seq_num;
    }
    Ok(())
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn unknown(message: &str) -> ShutdownCause {
    ShutdownCause::UnknownError(UnknownError::new(message))
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(std::string::ToString::to_string)
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into())
}

/// `hashMaterializerResults`: hashes the statements each event's materializer produces (no hash for unknown events).
fn materializer_hashes(schema: &Schema, events: &[Event]) -> Vec<MaterializerHash> {
    events
        .iter()
        .map(|event| {
            let statements = schema
                .event(&event.name)
                .and_then(|e| e.materializer.as_ref())
                .and_then(|m| m(&event.args, &MaterializeContext::new(event)).ok());
            // Same hash the session computes, so pure materializers always agree.
            let hash =
                statements.map(|s| livestore_sqlite::state::materializer_hash(&s).cast_unsigned());
            MaterializerHash {
                event_num: event.seq_num,
                hash,
            }
        })
        .collect()
}
