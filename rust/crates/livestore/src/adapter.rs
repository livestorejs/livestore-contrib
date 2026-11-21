//! In-process adapter (`makeInMemoryAdapter` / the tests' `makeTestAdapter`): a [`Leader`] in the same
//! process, the session DB seeded from the leader's state snapshot, and the proxy wired to it.

use std::sync::Arc;

use futures::{FutureExt, StreamExt};
use livestore_sqlite::LeaderDb;
use livestore_sync::{Leader, LeaderBuilder, ShutdownCause, Storage, SyncOptions};
use rusqlite::MAIN_DB;

use crate::errors::{Defect, StoreError};
use crate::session::{ClientSession, LeaderThreadProxy, PullItem};
use crate::sqlite::SqliteDbWrapper;
use crate::store::{Adapter, AdapterArgs, ensure_state_tables};

pub type ProxyOverride = Arc<dyn Fn(LeaderThreadProxy) -> LeaderThreadProxy + Send + Sync>;
pub type LeaderDbFactory = Arc<dyn Fn(Arc<livestore_schema::Schema>) -> LeaderDb + Send + Sync>;
pub type LeaderHook = Arc<dyn Fn(&Leader) + Send + Sync>;
pub type LeaderBuilderHook = Arc<dyn Fn(LeaderBuilder) -> LeaderBuilder + Send + Sync>;
pub type SessionOverride = Arc<dyn Fn(ClientSession) -> ClientSession + Send + Sync>;

#[derive(Clone)]
pub struct InMemoryAdapter {
    pub client_id: String,
    pub session_id: String,
    pub sync: Option<SyncOptions>,
    /// Session DB contents to start from instead of the leader's state (`importSnapshot`).
    pub import_snapshot: Option<Vec<u8>>,
    /// `testing.overrides.clientSession.leaderThreadProxy`.
    pub leader_thread_proxy: Option<ProxyOverride>,
    /// `testing.overrides.makeLeaderThread`: pre-built leader databases.
    pub make_leader_db: Option<LeaderDbFactory>,
    /// Extra leader configuration (params, testing hooks).
    pub leader_builder: Option<LeaderBuilderHook>,
    /// Final change of the session (e.g. its `shutdown`).
    pub client_session: Option<SessionOverride>,
    /// Observes the booted leader (tests inspect its sync state and databases).
    pub on_leader: Option<LeaderHook>,
}

impl Default for InMemoryAdapter {
    fn default() -> Self {
        Self {
            client_id: "test-client".into(),
            session_id: "static".into(),
            sync: None,
            import_snapshot: None,
            leader_thread_proxy: None,
            make_leader_db: None,
            leader_builder: None,
            client_session: None,
            on_leader: None,
        }
    }
}

impl InMemoryAdapter {
    #[must_use]
    pub fn build(self) -> Adapter {
        let config = Arc::new(self);
        Arc::new(move |args| make_session(config.clone(), args).boxed())
    }
}

#[must_use]
pub fn make_in_memory_adapter() -> Adapter {
    InMemoryAdapter::default().build()
}

async fn make_session(
    config: Arc<InMemoryAdapter>,
    args: AdapterArgs,
) -> Result<ClientSession, StoreError> {
    let storage = match &config.make_leader_db {
        Some(make) => Storage::Db(make(args.schema.clone())),
        None => Storage::InMemory,
    };
    let mut builder = Leader::builder(args.schema.clone())
        .store_id(&args.store_id)
        .client_id(&config.client_id)
        .storage(storage);
    if let Some(sync) = &config.sync {
        builder = builder.sync(sync.clone());
    }
    if let Some(hook) = &config.leader_builder {
        builder = hook(builder);
    }
    let leader = builder
        .boot()
        .await
        .map_err(|e| StoreError::Unknown(e.to_string()))?;
    if let Some(f) = &config.on_leader {
        f(&leader);
    }

    let snapshot = match &config.import_snapshot {
        Some(bytes) => bytes.clone(),
        None => leader
            .db()
            .lock()
            .expect("mutex poisoned")
            .state_conn()
            .serialize(MAIN_DB)
            .map(|d| d.to_vec())?,
    };
    let db = Arc::new(SqliteDbWrapper::from_snapshot(&snapshot)?);
    if config.import_snapshot.is_some() {
        ensure_state_tables(&db, &args.schema)?;
    }

    let mut proxy = leader_proxy(&leader);
    if let Some(f) = &config.leader_thread_proxy {
        proxy = f(proxy);
    }

    forward_leader_shutdown(&leader, args.shutdown.clone());
    let finalizer_leader = leader;
    args.lifetime
        .add_finalizer(async move { finalizer_leader.shutdown().await }.boxed());

    let session = ClientSession {
        sqlite_db: db,
        client_id: config.client_id.clone(),
        session_id: config.session_id.clone(),
        leader_thread: proxy,
        shutdown: args.shutdown,
        debug_instance_id: args.debug_instance_id,
    };
    Ok(match &config.client_session {
        Some(f) => f(session),
        None => session,
    })
}

/// The proxy over an in-process leader.
#[must_use]
pub fn leader_proxy(leader: &Leader) -> LeaderThreadProxy {
    let (push_leader, pull_leader, stream_leader) =
        (leader.clone(), leader.clone(), leader.clone());
    LeaderThreadProxy {
        push: Arc::new(move |batch| {
            let leader = push_leader.clone();
            async move { leader.push(batch).await.map_err(Into::into) }.boxed()
        }),
        pull: Arc::new(move |cursor| {
            let rx = pull_leader.pull_queue(cursor);
            futures::stream::unfold(rx, |mut rx| async move {
                rx.recv().await.map(|item| (Ok(PullItem::from(item)), rx))
            })
            .boxed()
        }),
        stream: Arc::new(move |query| {
            stream_leader
                .stream_events(query)
                .map(|r| r.map_err(Defect::new))
                .boxed()
        }),
        leader_head: leader.sync_state().borrow().local_head,
        network_status: leader.is_connected(),
    }
}

/// The leader's shutdown channel stops the store (`shutdownChannel.listen` → `adapterArgs.shutdown`).
fn forward_leader_shutdown(leader: &Leader, shutdown: crate::session::ShutdownFn) {
    let mut causes = leader.shutdown_cause();
    tokio::spawn(async move {
        let Ok(cause) = causes
            .wait_for(Option::is_some)
            .await
            .map(|c| c.clone().expect("checked"))
        else {
            return;
        };
        let exit = match cause {
            ShutdownCause::IntentionalShutdownCause(_) => Ok(()),
            ShutdownCause::MaterializeError(m) => Err(StoreError::Materialize(
                crate::errors::MaterializeCause::Other(m),
            )),
            ShutdownCause::MaterializationJournalError(m) => {
                Err(StoreError::MaterializationJournal(m))
            }
            other => Err(StoreError::Unknown(other.to_string())),
        };
        shutdown(exit).await;
    });
}
