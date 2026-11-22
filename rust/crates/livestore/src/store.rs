//! `Store` and `createStore` (`store/store.ts`, `store/create-store.ts`): synchronous commits and
//! queries on the session DB, reactive subscriptions, signals, the events stream and shutdown.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt, Shared};
use futures::stream::{BoxStream, StreamExt};
use livestore_core::{Event, SeqNum};
use livestore_schema::system_tables::state_tables;
use livestore_schema::{EventInput, Events};
use livestore_schema::{MaterializeContext, Schema, SqlStatement, SqlValue};
use livestore_sqlite::EventQuery;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tracing::{Instrument, Span};

use crate::errors::{Defect, Exit, MaterializeCause, StoreError};
use crate::live_queries::{Ctx, Queryable, RcEntry, SignalDef};
use crate::processor::{
    ClientSessionSyncProcessor, MaterializeOutput, ProcessorArgs, ProcessorParams,
    SESSION_ID_SYMBOL, StateServices,
};
use crate::reactive::{
    EffectsWrapper, GraphValue, ReactiveGraph, Ref, RefOptions, RefreshReason, SetRefOptions,
};
use crate::session::{ClientSession, ShutdownFn};
use crate::sqlite::{ExecuteOptions, SqliteDbWrapper, TableSet};

pub const STATE_REBUILD_BATCH_SIZE_DEFAULT: i64 = 100;
const STATE_HEAD_UPSERT: &str = "INSERT OR REPLACE INTO __livestore_state_head (id, seqNumGlobal, seqNumClient, seqNumRebaseGeneration) VALUES ($id, $seqNumGlobal, $seqNumClient, $seqNumRebaseGeneration)";
const SHUTDOWN_DRAIN_HARD_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_SOFT_BOUND: Duration = Duration::from_secs(1);

/// `Adapter`: builds the client session for a store.
pub type Adapter =
    Arc<dyn Fn(AdapterArgs) -> BoxFuture<'static, Result<ClientSession, StoreError>> + Send + Sync>;

#[derive(Clone)]
pub struct AdapterArgs {
    pub schema: Arc<Schema>,
    pub store_id: String,
    pub state_rebuild_batch_size: i64,
    /// Store shutdown (`args.shutdown`); adapters use it as the session's `shutdown`.
    pub shutdown: ShutdownFn,
    pub debug_instance_id: String,
    /// Registers work to run when the store's lifetime closes (after the processor drained).
    pub lifetime: LifetimeHandle,
}

/// `ShutdownDeferred`: resolved with the exit of the first store shutdown.
pub type ShutdownDeferred = Arc<watch::Sender<Option<Exit>>>;

#[must_use]
pub fn make_shutdown_deferred() -> ShutdownDeferred {
    Arc::new(watch::channel(None).0)
}

/// # Errors
///
/// Returns the error exit the store shut down with.
///
/// # Panics
///
/// Does not panic in practice: the value is read only after `wait_for` saw it set.
pub async fn await_shutdown(deferred: &ShutdownDeferred) -> Exit {
    let mut rx = deferred.subscribe();
    rx.wait_for(Option::is_some)
        .await
        .map_or(Ok(()), |v| v.clone().expect("checked"))
}

pub type BootFn = Arc<dyn Fn(&Store) + Send + Sync>;

#[derive(Clone, Default)]
pub struct StoreParams {
    pub leader_push_batch_size: Option<usize>,
    pub event_query_batch_size: Option<usize>,
    /// A JS number like in TS; validated as an integer >= 1 before the adapter sees it.
    pub state_rebuild_batch_size: Option<f64>,
}

#[derive(Clone)]
pub struct StoreOptions {
    pub schema: Arc<Schema>,
    /// `None` stands in for an invalid (`null`) adapter: creating the store fails synchronously.
    pub adapter: Option<Adapter>,
    pub store_id: String,
    pub boot: Option<BootFn>,
    pub shutdown_deferred: Option<ShutdownDeferred>,
    pub params: StoreParams,
    pub debug_instance_id: Option<String>,
    pub batch_updates: Option<EffectsWrapper>,
    pub rebase_barriers: HashMap<crate::processor::RebaseBarrierPoint, crate::processor::Barrier>,
}

impl StoreOptions {
    pub fn new(schema: Arc<Schema>, adapter: Adapter, store_id: &str) -> Self {
        Self {
            schema,
            adapter: Some(adapter),
            store_id: store_id.into(),
            boot: None,
            shutdown_deferred: None,
            params: StoreParams::default(),
            debug_instance_id: None,
            batch_updates: None,
            rebase_barriers: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CommitOptions {
    pub label: Option<String>,
    pub skip_refresh: bool,
}

#[derive(Clone, Default)]
pub struct SubscribeOptions {
    pub label: Option<String>,
    pub skip_initial_run: bool,
}

#[derive(Clone, Debug, Default)]
pub struct EventsOptions {
    pub since: Option<SeqNum>,
    pub until: Option<SeqNum>,
    pub filter: Option<Vec<String>>,
    pub client_ids: Option<Vec<String>>,
    pub session_ids: Option<Vec<String>>,
    pub batch_size: Option<usize>,
    pub include_client_only: bool,
}

/// `SyncStatus` of [`Store::sync_status`].
#[derive(Clone, Debug, PartialEq)]
pub struct SyncStatus {
    pub local_head: String,
    pub upstream_head: String,
    pub pending_count: usize,
    pub is_synced: bool,
}

/// The Store. Cheap to clone; clones are the same store (`toBe`).
#[derive(Clone)]
pub struct Store {
    pub(crate) inner: Arc<StoreInner>,
}

pub struct StoreInner {
    pub store_id: String,
    pub schema: Arc<Schema>,
    pub(crate) session: ClientSession,
    pub(crate) db: Arc<SqliteDbWrapper>,
    pub(crate) graph: ReactiveGraph<Ctx>,
    pub(crate) table_refs: HashMap<String, Ref<(), Ctx>>,
    pub(crate) def_rc_map: Mutex<HashMap<String, RcEntry>>,
    processor: ClientSessionSyncProcessor,
    lifetime: Arc<Lifetime>,
    params: StoreParams,
    is_shutdown: AtomicBool,
}

impl PartialEq for Store {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Store({})", self.inner.store_id)
    }
}

/// `createStore`.
///
/// # Errors
///
/// Fails when `state_rebuild_batch_size` is not an integer of at least 1, the store id has
/// characters other than ASCII letters, digits, `_` and `-`, no adapter is set, the adapter fails,
/// or the session database cannot be configured.
///
/// # Panics
///
/// Panics when called outside a tokio runtime. The store keeps that runtime for its tasks, so the
/// returned store can be used from any thread afterwards.
pub async fn create_store(options: StoreOptions) -> Result<Store, StoreError> {
    let state_rebuild_batch_size =
        validate_state_rebuild_batch_size(options.params.state_rebuild_batch_size)?;
    validate_store_id(&options.store_id)?;
    let adapter = options
        .adapter
        .clone()
        .ok_or_else(|| StoreError::defect("Cannot read properties of null (adapter)"))?;
    let lifetime = Arc::new(Lifetime {
        runtime: tokio::runtime::Handle::current(),
        processor: OnceLock::new(),
        teardown: Mutex::new(None),
        finalizers: Mutex::new(Vec::new()),
        shutdown_deferred: options.shutdown_deferred.clone(),
        spans: Mutex::new(None),
    });
    let shutdown: ShutdownFn = {
        let lifetime = Arc::downgrade(&lifetime);
        Arc::new(move |exit| {
            let lifetime = lifetime.clone();
            async move {
                if let Some(lifetime) = lifetime.upgrade() {
                    lifetime.shutdown(exit).await;
                }
            }
            .boxed()
        })
    };
    let debug_instance_id = options
        .debug_instance_id
        .clone()
        .unwrap_or_else(|| format!("instance-{}", rand_id()));
    let span = tracing::info_span!(
        "createStore",
        debugInstanceId = debug_instance_id.as_str(),
        storeId = options.store_id.as_str()
    );
    let session = adapter(AdapterArgs {
        schema: options.schema.clone(),
        store_id: options.store_id.clone(),
        state_rebuild_batch_size,
        shutdown,
        debug_instance_id,
        lifetime: LifetimeHandle(Arc::downgrade(&lifetime)),
    })
    .instrument(tracing::info_span!(parent: &span, "createStore:makeAdapter"))
    .await?;

    let store = span.in_scope(|| {
        let store = Store::new(options.schema.clone(), session, lifetime.clone(), &options)?;
        let _ = lifetime.processor.set(store.inner.processor.clone());
        store.inner.processor.boot();
        if let Some(boot) = &options.boot {
            boot(&store);
        }
        Ok::<_, StoreError>(store)
    })?;
    tokio::task::yield_now().await;
    Ok(store)
}

impl Store {
    fn new(
        schema: Arc<Schema>,
        session: ClientSession,
        lifetime: Arc<Lifetime>,
        options: &StoreOptions,
    ) -> Result<Self, StoreError> {
        session.sqlite_db.configure()?;
        let graph: ReactiveGraph<Ctx> = ReactiveGraph::new();
        let table_refs: HashMap<String, Ref<(), Ctx>> = schema
            .tables()
            .iter()
            .map(|t| {
                let r = graph.make_ref(
                    (),
                    RefOptions {
                        label: Some(format!("tableRef:{}", t.name)),
                        meta: Some(json!({ "liveStoreRefType": "table" })),
                        equal: Some(Arc::new(|(), ()| false)),
                    },
                );
                (t.name.clone(), r)
            })
            .collect();
        let db = session.sqlite_db.clone();
        let refresh_tables = {
            let (graph, refs) = (graph.clone(), table_refs.clone());
            Arc::new(move |tables: TableSet| {
                let to_update: Vec<_> = tables
                    .iter()
                    .filter_map(|t| refs.get(t))
                    .map(|r| (r, ()))
                    .collect();
                graph.set_refs(to_update, SetRefOptions::default());
            })
        };
        let materialize_event = {
            let (schema, db) = (schema.clone(), db.clone());
            Arc::new(move |event: &Event, leader_hash: Option<i64>| {
                materialize_event(&schema, &db, event, leader_hash)
            })
        };
        let processor = tracing::info_span!("makeClientSessionSyncProcessor").in_scope(|| {
            ClientSessionSyncProcessor::new(ProcessorArgs {
                schema: schema.clone(),
                client_session: session.clone(),
                materialize_event,
                refresh_tables,
                state: Arc::new(SessionState(db.clone())),
                params: ProcessorParams {
                    leader_push_batch_size: options.params.leader_push_batch_size.unwrap_or(100),
                    rebase_barriers: options.rebase_barriers.clone(),
                },
            })
        });
        let commits = tracing::info_span!("LiveStore:commits");
        let queries = tracing::info_span!("LiveStore:queries");
        *lock(&lifetime.spans) = Some(StoreSpans {
            create: Span::current(),
            commits,
            queries,
        });
        let inner = Arc::new_cyclic(|weak| {
            graph.set_context(weak.clone());
            if let Some(wrapper) = &options.batch_updates {
                graph.set_effects_wrapper(wrapper.clone());
            }
            StoreInner {
                store_id: options.store_id.clone(),
                schema,
                session,
                db,
                graph,
                table_refs,
                def_rc_map: Mutex::new(HashMap::new()),
                processor,
                lifetime,
                params: options.params.clone(),
                is_shutdown: AtomicBool::new(false),
            }
        });
        Ok(Store { inner })
    }

    #[must_use]
    pub fn store_id(&self) -> &str {
        &self.inner.store_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.inner.session.session_id
    }

    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.inner.session.client_id
    }

    #[must_use]
    pub fn schema(&self) -> &Arc<Schema> {
        &self.inner.schema
    }

    /// `store.commit(...events)`: one event, a tuple of events of mixed types, or a list.
    ///
    /// # Errors
    ///
    /// Fails when the store is shut down or the batch cannot be encoded or materialized; a
    /// materialization failure also shuts the store down.
    pub fn commit(&self, events: impl Events) -> Result<(), StoreError> {
        self.commit_with(CommitOptions::default(), events)
    }

    /// `store.commit(options, ...events)`.
    ///
    /// # Errors
    ///
    /// Same as [`Self::commit`].
    #[expect(
        clippy::needless_pass_by_value,
        reason = "options by value, so a call reads like `commit_with(CommitOptions { .. }, events)`"
    )]
    pub fn commit_with(
        &self,
        options: CommitOptions,
        events: impl Events,
    ) -> Result<(), StoreError> {
        self.check_shutdown("commit")?;
        self.commit_events(&options, events.into_inputs())
    }

    fn commit_events(
        &self,
        options: &CommitOptions,
        events: Vec<EventInput>,
    ) -> Result<(), StoreError> {
        let names: Vec<&str> = events.iter().map(EventInput::name).collect();
        let span = tracing::info_span!(
            parent: None,
            "LiveStore:commit",
            "livestore.eventsCount" = events.len(),
            "livestore.eventTags" = ?names,
            "livestore.commitLabel" = options.label.as_deref(),
        );
        span.follows_from(self.span(|s| &s.commits));
        let _entered = span.enter();
        if events.is_empty() {
            return Ok(());
        }
        let names: Vec<String> = events.iter().map(|e| e.name().to_owned()).collect();
        let write_tables = match self.inner.processor.commit(events) {
            Ok(tables) => tables,
            Err(e) => {
                tracing::error!(error = %e, label = ?options.label, "commit failed");
                let lifetime = self.inner.lifetime.clone();
                let exit = Err(e.clone());
                let runtime = lifetime.runtime.clone();
                runtime.spawn(async move { lifetime.shutdown(exit).await });
                return Err(e);
            }
        };
        let refs: Vec<_> = write_tables
            .iter()
            .filter_map(|t| self.inner.table_refs.get(t))
            .map(|r| (r, ()))
            .collect();
        let reason = RefreshReason::Other {
            tag: "commit".into(),
            data: json!({ "events": names, "writeTables": write_tables }),
        };
        self.inner.graph.set_refs(
            refs,
            SetRefOptions {
                skip_refresh: options.skip_refresh,
                debug_refresh_reason: Some(reason),
            },
        );
        Ok(())
    }

    /// `store.query(queryable)`. Signal instances stay alive after reading (like TS).
    pub fn query<Q: Queryable>(&self, query: &Q) -> Q::Result {
        let queries = self.span(|s| &s.queries);
        let _span = queries.enter();
        let rc = query.make(self);
        let result = rc.value.run();
        if rc.value.kind != crate::live_queries::LiveQueryKind::Signal {
            rc.deref();
        }
        result
    }

    /// `store.query({ query, bindValues })`: raw rows.
    ///
    /// # Errors
    ///
    /// Fails when the store is shut down or SQLite cannot run the query.
    pub fn query_raw(
        &self,
        sql: &str,
        binds: &[SqlValue],
    ) -> Result<Vec<livestore_sqlite::Row>, StoreError> {
        self.check_shutdown("query")?;
        Ok(self.inner.db.cached_select(sql, binds, None)?)
    }

    /// `store.setSignal(def, value)`.
    pub fn set_signal<T: GraphValue>(&self, def: &SignalDef<T>, value: T) {
        self.update_signal(def, |_| value);
    }

    /// `store.setSignal(def, (prev) => next)`.
    pub fn update_signal<T: GraphValue>(&self, def: &SignalDef<T>, f: impl FnOnce(T) -> T) {
        let rc = def.make(self);
        let crate::live_queries::Results::Ref(r) = &rc.value.results else {
            unreachable!("signals hold refs")
        };
        let next = f(r.compute_result());
        self.inner.graph.set_ref(r, next, SetRefOptions::default());
        // Keep the only reference so the set value isn't lost (TS does the same).
        if rc.rc() > 1 {
            rc.deref();
        }
    }

    /// `store.subscribe(query, onUpdate, options)`.
    pub fn subscribe<Q: Queryable>(
        &self,
        query: &Q,
        on_update: impl Fn(Q::Result) + Send + Sync + 'static,
        options: &SubscribeOptions,
    ) -> Subscription {
        let rc = query.make(self);
        let value = rc.value.clone();
        let span = tracing::info_span!(
            parent: &self.span(|s| &s.queries),
            "LiveStore.subscribe",
            label = options.label.as_deref(),
            queryLabel = value.label().as_str(),
        );
        let suppress = Arc::new(AtomicBool::new(options.skip_initial_run));
        let effect = {
            let (value, suppress) = (value.clone(), suppress.clone());
            self.inner.graph.make_effect(
                move |get| {
                    let _span = span.enter();
                    let result = get.get(&value.results);
                    if !suppress.load(Ordering::SeqCst) {
                        on_update(result);
                    }
                },
                Some(&format!(
                    "subscribe:{}",
                    options.label.as_deref().unwrap_or("undefined")
                )),
            )
        };
        if !value.is_destroyed() {
            effect.do_effect_with(Some(RefreshReason::Other {
                tag: "subscribe.initial".into(),
                data: json!({ "label": format!("subscribe-initial-run:{}", options.label.as_deref().unwrap_or("undefined")) }),
            }));
            suppress.store(false, Ordering::SeqCst);
        }
        let graph = self.inner.graph.clone();
        Subscription {
            unsubscribe: Some(Box::new(move || {
                graph.destroy_node(&effect);
                rc.deref();
            })),
        }
    }

    /// `store.subscribe(query)` as an async iterator: a stream of results; dropping it unsubscribes.
    pub fn subscribe_stream<Q: Queryable>(
        &self,
        query: &Q,
        options: &SubscribeOptions,
    ) -> BoxStream<'static, Q::Result>
    where
        Q::Result: 'static,
    {
        let (tx, rx) = mpsc::unbounded_channel();
        let subscription = self.subscribe(query, move |v| _ = tx.send(v), options);
        futures::stream::unfold((rx, subscription), |(mut rx, sub)| async move {
            rx.recv().await.map(|v| (v, (rx, sub)))
        })
        .boxed()
    }

    /// `store.eventsStream(options)`: confirmed events from the leader's eventlog.
    pub fn events_stream(
        &self,
        options: EventsOptions,
    ) -> BoxStream<'static, Result<Event, Defect>> {
        let batch_size = options
            .batch_size
            .or(self.inner.params.event_query_batch_size)
            .unwrap_or(100);
        (self.inner.session.leader_thread.stream)(EventQuery {
            since: options.since,
            until: options.until,
            filter: options.filter,
            client_ids: options.client_ids,
            session_ids: options.session_ids,
            batch_size: Some(batch_size),
            include_client_only: options.include_client_only,
        })
    }

    #[must_use]
    pub fn sync_status(&self) -> SyncStatus {
        let s = self.inner.processor.sync_state();
        SyncStatus {
            local_head: s.local_head.to_string(),
            upstream_head: s.upstream_head.to_string(),
            pending_count: s.pending.len(),
            is_synced: s.pending.is_empty(),
        }
    }

    #[must_use]
    pub fn network_status(&self) -> watch::Receiver<bool> {
        self.inner.session.leader_thread.network_status.clone()
    }

    /// `manualRefresh`: runs effects deferred by `skip_refresh` commits.
    pub fn manual_refresh(&self, label: Option<&str>) {
        self.inner
            .graph
            .run_deferred_effects(label.map(RefreshReason::tagged).as_ref());
    }

    /// `store.shutdown(cause?)`: stops the session (graceful drain unless a cause is given).
    pub async fn shutdown(&self, cause: Option<StoreError>) {
        self.inner.is_shutdown.store(true, Ordering::SeqCst);
        self.inner
            .lifetime
            .shutdown(cause.map_or(Ok(()), Err))
            .await;
    }

    /// Closing the scope the store was created in: drain, then release the adapter's resources.
    pub async fn close(&self) {
        let teardown = self.inner.lifetime.start_teardown(Ok(()));
        let _ = tokio::time::timeout(SHUTDOWN_SOFT_BOUND, teardown).await;
    }

    #[must_use]
    pub fn is_shutdown(&self) -> bool {
        self.inner.is_shutdown.load(Ordering::SeqCst)
    }

    // `store[StoreInternalsSymbol]`

    #[must_use]
    pub fn sync_processor(&self) -> &ClientSessionSyncProcessor {
        &self.inner.processor
    }

    #[must_use]
    pub fn sqlite_db_wrapper(&self) -> &Arc<SqliteDbWrapper> {
        &self.inner.db
    }

    #[must_use]
    pub fn reactivity_graph(&self) -> &ReactiveGraph<Ctx> {
        &self.inner.graph
    }

    #[must_use]
    pub fn client_session(&self) -> &ClientSession {
        &self.inner.session
    }

    /// One of the store's spans; none once the teardown closed them.
    fn span(&self, pick: impl FnOnce(&StoreSpans) -> &Span) -> Span {
        lock(&self.inner.lifetime.spans)
            .as_ref()
            .map_or_else(Span::none, |s| pick(s).clone())
    }

    fn check_shutdown(&self, operation: &str) -> Result<(), StoreError> {
        if self.is_shutdown() {
            return Err(StoreError::Unknown(format!(
                "Store has been shut down (while performing \"{operation}\")."
            )));
        }
        Ok(())
    }
}

/// Returned by [`Store::subscribe`]; dropping it or calling [`Subscription::unsubscribe`] stops it.
#[must_use]
pub struct Subscription {
    unsubscribe: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl Subscription {
    pub fn unsubscribe(mut self) {
        if let Some(f) = self.unsubscribe.take() {
            f();
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // Streams own their subscription: dropping one ends it (`iterator.return()`).
        if let Some(f) = self.unsubscribe.take() {
            f();
        }
    }
}

/// Teardown of one store: the processor drain, then the adapter's finalizers. Runs once.
pub(crate) struct Lifetime {
    /// The runtime that created the store. Teardown spawns on it, so callers need no tokio context.
    runtime: tokio::runtime::Handle,
    processor: OnceLock<ClientSessionSyncProcessor>,
    teardown: Mutex<Option<Shared<BoxFuture<'static, ()>>>>,
    finalizers: Mutex<Vec<BoxFuture<'static, ()>>>,
    shutdown_deferred: Option<ShutdownDeferred>,
    spans: Mutex<Option<StoreSpans>>,
}

/// `createStore` and the store's `LiveStore:commits` / `LiveStore:queries` spans, closed by the teardown.
struct StoreSpans {
    create: Span,
    commits: Span,
    queries: Span,
}

impl Lifetime {
    /// Starts the teardown in its own task (it outlives a timed-out shutdown call).
    fn start_teardown(self: &Arc<Self>, exit: Exit) -> Shared<BoxFuture<'static, ()>> {
        let mut teardown = lock(&self.teardown);
        if let Some(t) = &*teardown {
            return t.clone();
        }
        let processor = self.processor.get().cloned();
        let finalizers = std::mem::take(&mut *lock(&self.finalizers));
        let spans = lock(&self.spans).take();
        let shutdown_span = spans.as_ref().map_or_else(
            Span::none,
            |s| tracing::info_span!(parent: &s.create, "client-session-sync-processor:shutdown"),
        );
        // Like the TS scope finalizer, the request happens before yielding: no pull is accepted after it.
        let drain = processor.map(|p| {
            shutdown_span
                .in_scope(|| p.begin_shutdown(exit))
                .instrument(shutdown_span)
        });
        let task = self.runtime.spawn(async move {
            if let Some(drain) = drain
                && tokio::time::timeout(SHUTDOWN_DRAIN_HARD_TIMEOUT, drain)
                    .await
                    .is_err()
            {
                tracing::error!(
                    "@livestore/livestore:shutdown: drain exceeded hard bound; forcing scope close"
                );
            }
            for finalizer in finalizers {
                finalizer.await;
            }
            if let Some(StoreSpans {
                create,
                commits,
                queries,
            }) = spans
            {
                drop(commits);
                drop(queries);
                drop(create);
            }
        });
        let shared = async move {
            let _ = task.await;
        }
        .boxed()
        .shared();
        *teardown = Some(shared.clone());
        shared
    }

    async fn shutdown(self: &Arc<Self>, exit: Exit) {
        let teardown = self.start_teardown(exit.clone());
        if tokio::time::timeout(SHUTDOWN_SOFT_BOUND, teardown)
            .await
            .is_err()
        {
            tracing::error!("@livestore/livestore:shutdown: Timed out after 1 second");
        }
        if let Some(deferred) = &self.shutdown_deferred {
            deferred.send_if_modified(|v| {
                if v.is_some() {
                    return false;
                }
                *v = Some(exit);
                true
            });
        }
    }
}

/// Lets an adapter register finalizers on the store's lifetime.
#[derive(Clone)]
pub struct LifetimeHandle(std::sync::Weak<Lifetime>);

impl LifetimeHandle {
    pub fn add_finalizer(&self, f: BoxFuture<'static, ()>) {
        if let Some(lifetime) = self.0.upgrade() {
            lock(&lifetime.finalizers).push(f);
        }
    }
}

/// The session DB as the processor's state services.
struct SessionState(Arc<SqliteDbWrapper>);

impl StateServices for SessionState {
    fn begin_savepoint(&self) -> Result<String, StoreError> {
        Ok(self.0.begin_savepoint()?)
    }

    fn release_savepoint(&self, name: &str) -> Result<(), StoreError> {
        Ok(self.0.release_savepoint(name)?)
    }

    fn rollback_savepoint(&self, name: &str) -> Result<(), StoreError> {
        Ok(self.0.rollback_savepoint(name)?)
    }

    /// `StateHead.set` through `execSql`, with its span.
    fn set_head(&self, head: SeqNum) -> Result<(), StoreError> {
        let _span = tracing::debug_span!(
            "@livestore/common:execSql",
            "span.label" = STATE_HEAD_UPSERT,
            sql = STATE_HEAD_UPSERT,
            bindValueKeys = "$id, $seqNumGlobal, $seqNumClient, $seqNumRebaseGeneration",
        )
        .entered();
        let params = rusqlite::named_params! {
            "$id": 1, "$seqNumGlobal": head.global, "$seqNumClient": head.client, "$seqNumRebaseGeneration": head.rebase_generation,
        };
        self.0.with_conn(|c| c.execute(STATE_HEAD_UPSERT, params))?;
        Ok(())
    }

    fn journal_rollback(&self, keys: &[SeqNum]) -> Result<(), StoreError> {
        let result = self
            .0
            .with_conn(|c| livestore_sqlite::state::rollback(c, keys));
        self.0.clear_cache();
        result.map_err(StoreError::from_sqlite)
    }

    fn journal_discard_up_to(&self, key: SeqNum) -> Result<(), StoreError> {
        Ok(self
            .0
            .with_conn(|c| livestore_sqlite::state::discard_journal_up_to(c, key))?)
    }
}

/// The Store's `materializeEvent`: resolve, materialize through the cache-aware DB, journal the changeset.
fn materialize_event(
    schema: &Schema,
    db: &SqliteDbWrapper,
    event: &Event,
    leader_hash: Option<i64>,
) -> Result<MaterializeOutput, StoreError> {
    let materialize_error = |m: String| StoreError::Materialize(MaterializeCause::Other(m));
    let materializer = match schema.resolve(event, "@livestore/livestore:store:materializeEvent") {
        Err(e) => return Err(materialize_error(e.to_string())),
        Ok(None) => {
            // Unknown to this schema: keep the log entry, skip materialization.
            journal_record(db, event.seq_num, None)?;
            return Ok(MaterializeOutput::default());
        }
        Ok(Some(m)) => m.clone(),
    };
    let query = |sql: &str, binds: &[SqlValue]| {
        db.select(sql, binds)
            .map(|rows| rows.into_iter().map(Value::Object).collect())
            .map_err(|e| livestore_schema::MaterializeError::Other(e.to_string()))
    };
    let statements = materializer(
        &event.args,
        &MaterializeContext {
            event,
            query: Some(&query),
        },
    )
    .map_err(|e| materialize_error(e.to_string()))?;
    let hash = materializer_hash(&statements);
    if leader_hash.is_some_and(|leader| leader != hash) {
        return Err(StoreError::Materialize(
            MaterializeCause::MaterializerHashMismatch {
                event_name: event.name.clone(),
            },
        ));
    }
    let (write_tables, changeset) = db.with_changeset(|| {
        let mut write_tables = TableSet::new();
        for s in &statements {
            let tables = db.tables_used(&s.sql);
            db.cached_execute(
                &s.sql,
                &s.binds,
                ExecuteOptions {
                    has_no_effects: false,
                    write_tables: Some(tables.clone()),
                },
            )
            .map_err(|e| {
                materialize_error(format!(
                    "Error executing materializer for event \"{}\".\nStatement: {}\nCause: {e}",
                    event.name, s.sql
                ))
            })?;
            write_tables.extend(tables);
        }
        Ok::<_, StoreError>(write_tables)
    })?;
    journal_record(db, event.seq_num, changeset.as_deref())?;
    Ok(MaterializeOutput {
        write_tables,
        materializer_hash: Some(hash),
    })
}

/// `hashMaterializerResults`: identical statements hash identically on leader and session.
#[must_use]
pub fn materializer_hash(statements: &[SqlStatement]) -> i64 {
    livestore_sqlite::state::materializer_hash(statements)
}

fn journal_record(
    db: &SqliteDbWrapper,
    key: SeqNum,
    changeset: Option<&[u8]>,
) -> Result<(), StoreError> {
    db.with_conn(|c| livestore_sqlite::state::journal_record(c, key, changeset))
        .map_err(|e| StoreError::MaterializationJournal(e.to_string()))
}

/// `resolveSessionIdSymbolInBindValues`.
pub(crate) fn resolve_session_id_bind(value: &SqlValue, session_id: &str) -> SqlValue {
    match value {
        SqlValue::Text(s) if s == SESSION_ID_SYMBOL => SqlValue::Text(session_id.into()),
        other => other.clone(),
    }
}

/// Creates state and system tables missing from an imported snapshot (`migrateDb`, create-only).
///
/// # Errors
///
/// Fails when SQLite rejects one of the `CREATE TABLE` statements.
pub fn ensure_state_tables(db: &SqliteDbWrapper, schema: &Schema) -> Result<(), StoreError> {
    for sql in state_tables()
        .iter()
        .chain(schema.tables())
        .flat_map(livestore_schema::Table::ddl)
    {
        db.execute(&sql)?;
    }
    Ok(())
}

/// `StateRebuildBatchSizeSchema`: a finite integer of at least 1.
#[expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "the size is a JS number; it is checked to be an integer in i64 range before the cast"
)]
fn validate_state_rebuild_batch_size(size: Option<f64>) -> Result<i64, StoreError> {
    match size {
        None => Ok(STATE_REBUILD_BATCH_SIZE_DEFAULT),
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= 1.0 && n <= i64::MAX as f64 => {
            Ok(n as i64)
        }
        Some(n) => Err(StoreError::Unknown(format!(
            "Invalid stateRebuildBatchSize: {n}"
        ))),
    }
}

fn validate_store_id(store_id: &str) -> Result<(), StoreError> {
    if store_id.is_empty()
        || !store_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(StoreError::Unknown(format!(
            "Invalid storeId: {store_id}. Only alphanumeric characters, underscores, and hyphens are allowed."
        )));
    }
    Ok(())
}

pub(crate) fn rand_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    format!("{:010x}", h.finish() & 0xff_ffff_ffff)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
