//! `makeLeaderThreadLayer` as a typed builder, and the [`Leader`] handle (`LeaderThreadCtx`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::Stream;
use livestore_core::{Event, SeqNum, SyncState};
use livestore_schema::Schema;
use livestore_sqlite::{EventQuery, LeaderDb, Row};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;

use crate::backend::{BackendIdStore, MakeBackendArgs, PageInfo, SyncBackend};
use crate::errors::{LeaderPushError, ShutdownCause, UnknownError};
use crate::options::{InitialSyncOptions, Params, Random, StdRandom, SyncOptions, Testing};
use crate::processor::{Config, Deps, Msg, Processor};
use crate::pull_queue::{PullQueue, PullQueueSet};
use crate::stream_events::stream_events;

#[expect(
    clippy::large_enum_variant,
    reason = "built once per leader; boxing the open database buys nothing"
)]
pub enum Storage {
    InMemory,
    Files {
        state: PathBuf,
        eventlog: PathBuf,
    },
    /// An already opened database (lets tests inspect or pre-seed it).
    Db(LeaderDb),
}

/// `BootStatus`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootStatus {
    Loading,
    Syncing { done: usize, total: i64 },
    Done,
}

pub struct LeaderBuilder {
    schema: Arc<Schema>,
    store_id: String,
    client_id: String,
    payload: Option<serde_json::Value>,
    storage: Storage,
    sync: SyncOptions,
    params: Params,
    testing: Testing,
    random: Arc<dyn Random>,
}

impl LeaderBuilder {
    #[must_use]
    pub fn store_id(mut self, store_id: &str) -> Self {
        self.store_id = store_id.into();
        self
    }

    #[must_use]
    pub fn client_id(mut self, client_id: &str) -> Self {
        self.client_id = client_id.into();
        self
    }

    /// `syncPayload`, handed to the backend constructor.
    #[must_use]
    pub fn sync_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = Some(payload);
        self
    }

    #[must_use]
    pub fn storage(mut self, storage: Storage) -> Self {
        self.storage = storage;
        self
    }

    #[must_use]
    pub fn sync(mut self, options: SyncOptions) -> Self {
        self.sync = options;
        self
    }

    #[must_use]
    pub fn params(mut self, params: Params) -> Self {
        self.params = params;
        self
    }

    #[must_use]
    pub fn testing(mut self, testing: Testing) -> Self {
        self.testing = testing;
        self
    }

    #[must_use]
    pub fn random(mut self, random: Arc<dyn Random>) -> Self {
        self.random = random;
        self
    }

    /// Opens the databases (rebuilding incomplete state), makes the backend, starts the sync processor
    /// and, with `InitialSyncOptions::Blocking`, waits for the first pull to finish or time out.
    ///
    /// # Errors
    ///
    /// Fails with [`UnknownError`] when opening or booting the databases fails or the backend constructor fails.
    pub async fn boot(self) -> Result<Leader, UnknownError> {
        let span =
            tracing::info_span!("@livestore/common:leader-thread:boot", store_id = %self.store_id);
        self.boot_inner().instrument(span).await
    }

    async fn boot_inner(self) -> Result<Leader, UnknownError> {
        let db = match self.storage {
            Storage::InMemory => LeaderDb::open_in_memory(self.schema.clone()),
            Storage::Files { state, eventlog } => {
                LeaderDb::open(state, eventlog, self.schema.clone())
            }
            Storage::Db(db) => Ok(db),
        }
        .map_err(UnknownError::new)?;
        let initial = db.initial_sync_state().map_err(UnknownError::new)?;
        let db = Arc::new(Mutex::new(db));

        let backend = match &self.sync.backend {
            None => None,
            Some(make) => {
                let args = MakeBackendArgs {
                    store_id: self.store_id.clone(),
                    client_id: self.client_id.clone(),
                    payload: self.payload.clone(),
                    backend_id: Arc::new(DbBackendId(db.clone())),
                };
                Some(make(args).await?)
            }
        };
        let cancel = CancellationToken::new();
        if let Some(backend) = &backend {
            // Connect concurrently to speed up the first pull/push.
            let connect = backend.connect();
            let token = cancel.clone();
            tokio::spawn(async move {
                tokio::select! {
                    result = connect => if let Err(e) = result { tracing::debug!(%e, "sync backend connect failed") },
                    () = token.cancelled() => {}
                }
            });
        }

        let (blocking_tx, mut blocking_rx) = watch::channel(false);
        let (boot_status, _) = watch::channel(BootStatus::Loading);
        let initial_sync = Arc::new(InitialSync {
            progress: Mutex::new((false, 0, -1)),
            blocking: matches!(self.sync.initial_sync, InitialSyncOptions::Blocking { .. })
                .then_some(blocking_tx),
            boot_status: boot_status.clone(),
        });

        let (mailbox, mailbox_rx) = mpsc::unbounded_channel();
        let (sync_state, _) = watch::channel(initial.clone());
        let (shutdown, _) = watch::channel(None);
        let sessions = Arc::new(PullQueueSet::default());
        let deps = Deps {
            schema: self.schema.clone(),
            db: db.clone(),
            backend: backend.clone(),
            config: Config {
                live_pull: self.sync.live_pull.unwrap_or(true),
                params: self.params,
                on_sync_error: self.sync.on_sync_error,
                on_backend_id_mismatch: self.sync.on_backend_id_mismatch,
                backoff: self.sync.backoff,
            },
            testing: self.testing,
            random: self.random,
            sync_state: sync_state.clone(),
            shutdown: shutdown.clone(),
            sessions: sessions.clone(),
            initial_sync,
            mailbox: mailbox.clone(),
            cancel: cancel.clone(),
        };
        // FIFO mailbox: `Started` is handled before any push.
        let _ = mailbox.send(Msg::Started);
        let actor = tokio::spawn(Processor::new(deps, initial).run(mailbox_rx));

        if let InitialSyncOptions::Blocking { timeout } = self.sync.initial_sync {
            boot_status.send_replace(BootStatus::Syncing { done: 0, total: -1 });
            let _ = tokio::time::timeout(timeout, blocking_rx.wait_for(|done| *done)).await;
        }
        boot_status.send_replace(BootStatus::Done);

        Ok(Leader {
            inner: Arc::new(Inner {
                schema: self.schema,
                store_id: self.store_id,
                client_id: self.client_id,
                db,
                backend,
                mailbox,
                sync_state,
                shutdown,
                boot_status,
                sessions,
                cancel,
                actor: Mutex::new(Some(actor)),
            }),
        })
    }
}

/// The leader thread context: one per client, shared by any number of client sessions.
/// Cheap to clone; dropping the last clone cancels all leader work.
#[derive(Clone)]
pub struct Leader {
    inner: Arc<Inner>,
}

struct Inner {
    schema: Arc<Schema>,
    store_id: String,
    client_id: String,
    db: Arc<Mutex<LeaderDb>>,
    backend: Option<Arc<dyn SyncBackend>>,
    mailbox: mpsc::UnboundedSender<Msg>,
    sync_state: watch::Sender<SyncState>,
    shutdown: watch::Sender<Option<ShutdownCause>>,
    boot_status: watch::Sender<BootStatus>,
    sessions: Arc<PullQueueSet>,
    cancel: CancellationToken,
    actor: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Leader {
    #[must_use]
    pub fn builder(schema: Arc<Schema>) -> LeaderBuilder {
        LeaderBuilder {
            schema,
            store_id: "default".into(),
            client_id: "client".into(),
            payload: None,
            storage: Storage::InMemory,
            sync: SyncOptions::default(),
            params: Params::default(),
            testing: Testing::default(),
            random: Arc::new(StdRandom),
        }
    }

    /// `LeaderSyncProcessor.push`: resolves after the batch is durable, published and scheduled for the backend.
    ///
    /// # Errors
    ///
    /// Fails with [`LeaderPushError::Rejected`] when the batch does not fit after the local head and must be rebased, and with
    /// [`LeaderPushError::Interrupted`] when the leader stops before the batch is handled.
    pub async fn push(&self, events: Vec<Event>) -> Result<(), LeaderPushError> {
        if events.is_empty() {
            return Ok(());
        }
        let span = tracing::debug_span!(
            "@livestore/common:LeaderSyncProcessor:push",
            batchSize = events.len(),
            batch = "undefined"
        );
        let (reply, rx) = oneshot::channel();
        self.inner
            .mailbox
            .send(Msg::LocalPushRequested { events, reply })
            .map_err(|_| LeaderPushError::Interrupted)?;
        rx.instrument(span)
            .await
            .unwrap_or(Err(LeaderPushError::Interrupted))
    }

    /// `pullQueue({ cursor })`: published payloads after `cursor`, then live ones.
    #[must_use]
    pub fn pull_queue(&self, cursor: SeqNum) -> PullQueue {
        self.inner.sessions.make_queue(cursor)
    }

    /// `syncState` subscribable: `borrow()` = get, `changed()` = changes.
    #[must_use]
    pub fn sync_state(&self) -> watch::Receiver<SyncState> {
        self.inner.sync_state.subscribe()
    }

    /// The shutdown channel: set once when the leader stops with a cause.
    #[must_use]
    pub fn shutdown_cause(&self) -> watch::Receiver<Option<ShutdownCause>> {
        self.inner.shutdown.subscribe()
    }

    #[must_use]
    pub fn boot_status(&self) -> watch::Receiver<BootStatus> {
        self.inner.boot_status.subscribe()
    }

    /// `streamEventsWithSyncState` over this leader's eventlog.
    pub fn stream_events(
        &self,
        query: EventQuery,
    ) -> impl Stream<Item = Result<Event, livestore_sqlite::Error>> + Send + 'static {
        stream_events(self.inner.db.clone(), self.sync_state(), query)
    }

    /// `networkStatus`: backend connectivity with change timestamps.
    pub fn network_status(&self) -> Option<watch::Receiver<crate::backend::NetworkStatus>> {
        self.inner
            .backend
            .as_ref()
            .map(crate::backend::network_status)
    }

    /// Network status (`isConnected` of the backend; `false` without one).
    #[must_use]
    pub fn is_connected(&self) -> watch::Receiver<bool> {
        match &self.inner.backend {
            Some(b) => b.is_connected(),
            None => watch::channel(false).1,
        }
    }

    /// Runs a read query on the state DB.
    ///
    /// # Errors
    ///
    /// Fails with [`livestore_sqlite::Error::Sqlite`] when `sql` does not prepare or run.
    ///
    /// # Panics
    ///
    /// Panics when the database mutex is poisoned.
    pub fn query(&self, sql: &str) -> Result<Vec<Row>, livestore_sqlite::Error> {
        self.inner.db.lock().expect("mutex poisoned").query(sql)
    }

    /// Direct access to the databases (tests, devtools-like inspection).
    #[must_use]
    pub fn db(&self) -> &Arc<Mutex<LeaderDb>> {
        &self.inner.db
    }

    #[must_use]
    pub fn schema(&self) -> &Arc<Schema> {
        &self.inner.schema
    }

    #[must_use]
    pub fn store_id(&self) -> &str {
        &self.inner.store_id
    }

    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.inner.client_id
    }

    #[must_use]
    pub fn sync_backend(&self) -> Option<&Arc<dyn SyncBackend>> {
        self.inner.backend.as_ref()
    }

    /// Stops the processor (scope close) and waits for it.
    ///
    /// # Panics
    ///
    /// Panics when the actor mutex is poisoned.
    pub async fn shutdown(&self) {
        let _ = self.inner.mailbox.send(Msg::ShutdownRequested);
        let actor = self.inner.actor.lock().expect("mutex poisoned").take();
        if let Some(actor) = actor {
            let _ = actor.await;
        }
        self.inner.sessions.close();
        self.inner.cancel.cancel();
    }
}

/// `InitialBlockingSyncContext`.
pub(crate) struct InitialSync {
    /// `(isDone, processedEvents, total)`.
    pub progress: Mutex<(bool, usize, i64)>,
    pub blocking: Option<watch::Sender<bool>>,
    pub boot_status: watch::Sender<BootStatus>,
}

impl InitialSync {
    pub fn update(&self, processed: usize, page_info: &PageInfo) {
        let mut p = self.progress.lock().expect("mutex poisoned");
        if p.0 {
            return;
        }
        if p.2 == -1
            && let PageInfo::MoreKnown { remaining } = page_info
        {
            p.2 = i64::try_from(*remaining)
                .unwrap_or(i64::MAX)
                .saturating_add(i64::try_from(processed).unwrap_or(i64::MAX));
        }
        p.1 += processed;
        self.boot_status.send_replace(BootStatus::Syncing {
            done: p.1,
            total: p.2,
        });
        if *page_info == PageInfo::NoMore
            && let Some(blocking) = &self.blocking
        {
            blocking.send_replace(true);
            p.0 = true;
        }
    }
}

struct DbBackendId(Arc<Mutex<LeaderDb>>);

impl BackendIdStore for DbBackendId {
    fn get(&self) -> Option<String> {
        self.0
            .lock()
            .expect("mutex poisoned")
            .backend_id()
            .ok()
            .flatten()
    }

    fn set(&self, backend_id: &str) {
        if let Err(e) = self
            .0
            .lock()
            .expect("mutex poisoned")
            .set_backend_id(backend_id)
        {
            tracing::warn!(%e, "failed to store backend id");
        }
    }
}
