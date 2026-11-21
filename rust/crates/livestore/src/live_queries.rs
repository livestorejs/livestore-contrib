//! Live query definitions (`signal`, `computed`, `queryDb`) and their reference-counted instances
//! (`live-queries/*.ts`). A definition is a blueprint; `make` creates (or reuses, by hash) the instance
//! bound to a Store's reactivity graph.

use std::any::Any;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use livestore_schema::query_builder::Select;
use livestore_schema::{ClientDocument, SqlValue, Val};
use livestore_sqlite::Row;
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use tracing::field::Empty;

use crate::reactive::{
    Atom, Get, GraphValue, NodeHandle, NodeId, Ref, RefOptions, RefreshReason, Thunk,
};
use crate::sqlite::TableSet;
use crate::store::{Store, StoreInner};

pub type Ctx = Weak<StoreInner>;

static IDS: AtomicU64 = AtomicU64::new(0);

/// Anything `store.query` / `store.subscribe` accept (`Queryable`).
pub trait Queryable {
    type Result: GraphValue;
    fn make(&self, store: &Store) -> RcRef<Self::Result>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveQueryKind {
    Computed,
    Db,
    Signal,
}

/// `results$`: a ref (signals) or a thunk (computed and db queries).
pub enum Results<T> {
    Ref(Ref<T, Ctx>),
    Thunk(Thunk<T, Ctx>),
}

impl<T> NodeHandle for Results<T> {
    fn node_id(&self) -> usize {
        match self {
            Results::Ref(r) => r.node_id(),
            Results::Thunk(t) => t.node_id(),
        }
    }
}

impl<T> Atom<T> for Results<T> {}

/// `LiveQuery`: an instance in the reactivity graph.
pub struct LiveQuery<T> {
    pub id: u64,
    pub kind: LiveQueryKind,
    pub hash: String,
    label: Mutex<String>,
    pub results: Results<T>,
    extra_nodes: Vec<NodeId>,
    dependencies: Arc<Mutex<Vec<RcDeref>>>,
    destroyed: AtomicBool,
    store: Ctx,
}

impl<T: GraphValue> LiveQuery<T> {
    pub fn label(&self) -> String {
        lock(&self.label).clone()
    }

    pub fn is_destroyed(&self) -> bool {
        self.destroyed.load(Ordering::SeqCst)
    }

    /// `run`: computes the current result.
    pub fn run(&self) -> T {
        match &self.results {
            Results::Ref(r) => r.compute_result(),
            Results::Thunk(t) => t.compute_result(),
        }
    }

    /// `runs`: recomputations of the results thunk.
    pub fn runs(&self) -> u64 {
        match &self.results {
            Results::Ref(_) => 0,
            Results::Thunk(t) => t.recomputations(),
        }
    }

    fn destroy(&self) {
        self.destroyed.store(true, Ordering::SeqCst);
        if let Some(store) = self.store.upgrade() {
            store.graph.destroy_node(&self.results);
            for node in &self.extra_nodes {
                store.graph.destroy_node(node);
            }
        }
        for dep in std::mem::take(&mut *lock(&self.dependencies)) {
            dep();
        }
    }
}

type RcDeref = Arc<dyn Fn() + Send + Sync>;

/// `RcRef`: a shared instance plus its release.
pub struct RcRef<T> {
    pub value: Arc<LiveQuery<T>>,
    deref: RcDeref,
    store: Ctx,
    hash: Option<String>,
}

impl<T> RcRef<T> {
    pub fn deref(&self) {
        (self.deref)();
    }

    /// Current reference count (`rc`).
    #[must_use]
    pub fn rc(&self) -> usize {
        match (&self.hash, self.store.upgrade()) {
            (Some(hash), Some(store)) => lock(&store.def_rc_map).get(hash).map_or(0, |e| e.rc),
            _ => 1,
        }
    }
}

pub(crate) struct RcEntry {
    rc: usize,
    value: Arc<dyn Any + Send + Sync>,
    destroy: Arc<dyn Fn() + Send + Sync>,
}

/// `withRCMap`: reuses the instance registered under `hash`, or creates it.
fn with_rc_map<T: GraphValue>(
    store: &Store,
    hash: &str,
    make: impl FnOnce() -> Arc<LiveQuery<T>>,
) -> RcRef<T> {
    let inner = &store.inner;
    let existing = {
        let mut map = lock(&inner.def_rc_map);
        map.get_mut(hash).map(|e| {
            e.rc += 1;
            e.value.clone()
        })
    };
    let value = if let Some(v) = existing {
        v.downcast::<LiveQuery<T>>()
            .expect("one result type per query hash")
    } else {
        let query = make();
        let destroy_target = query.clone();
        let entry = RcEntry {
            rc: 1,
            value: query.clone(),
            destroy: Arc::new(move || destroy_target.destroy()),
        };
        lock(&inner.def_rc_map).insert(hash.into(), entry);
        query
    };
    let (weak, key) = (Arc::downgrade(inner), hash.to_string());
    let deref: RcDeref = Arc::new(move || {
        let Some(store) = weak.upgrade() else { return };
        let destroy = {
            let mut map = lock(&store.def_rc_map);
            let Some(entry) = map.get_mut(&key) else {
                return;
            };
            entry.rc -= 1;
            (entry.rc == 0).then(|| map.remove(&key).expect("present").destroy)
        };
        if let Some(destroy) = destroy {
            destroy();
        }
    });
    RcRef {
        value,
        deref,
        store: Arc::downgrade(inner),
        hash: Some(hash.into()),
    }
}

/// The getter handed to `computed` and `queryDb` functions (`makeGetAtomResult`): reading a definition
/// makes (and keeps) its instance and depends on its results.
pub struct QueryGet<'a> {
    get: &'a Get<'a, Ctx>,
    store: Store,
    dependencies: &'a Arc<Mutex<Vec<RcDeref>>>,
}

impl QueryGet<'_> {
    pub fn get<Q: Queryable>(&self, query: &Q) -> Q::Result {
        let rc = query.make(&self.store);
        lock(self.dependencies).push(rc.deref.clone());
        self.get.get(&rc.value.results)
    }

    /// Reads a plain graph atom.
    pub fn get_atom<T: GraphValue>(&self, atom: &impl Atom<T>) -> T {
        self.get.get(atom)
    }

    #[must_use]
    pub fn store(&self) -> &Store {
        &self.store
    }
}

// signal

/// `signal(default, { label })`.
pub struct SignalDef<T> {
    pub default_value: T,
    pub hash: String,
    pub label: String,
}

impl<T: Clone> Clone for SignalDef<T> {
    fn clone(&self) -> Self {
        Self {
            default_value: self.default_value.clone(),
            hash: self.hash.clone(),
            label: self.label.clone(),
        }
    }
}

pub fn signal<T: GraphValue>(default_value: T, label: Option<&str>) -> SignalDef<T> {
    SignalDef {
        default_value,
        hash: format!("signal-{}", IDS.fetch_add(1, Ordering::Relaxed)),
        label: label.unwrap_or("Signal").into(),
    }
}

impl<T: GraphValue> Queryable for SignalDef<T> {
    type Result = T;

    fn make(&self, store: &Store) -> RcRef<T> {
        with_rc_map(store, &self.hash, || {
            let r = store
                .inner
                .graph
                .make_ref(self.default_value.clone(), RefOptions::label(&self.label));
            Arc::new(new_query(
                store,
                LiveQueryKind::Signal,
                &self.hash,
                &self.label,
                Results::Ref(r),
                vec![],
                None,
            ))
        })
    }
}

// computed

type ComputeFn<T> = Arc<dyn Fn(&QueryGet<'_>) -> T + Send + Sync>;

/// `computed(fn, { label, deps })`. Closures have no source text, so without `deps` each definition
/// has its own identity (TS hashes `fn.toString()`).
pub struct ComputedDef<T> {
    f: ComputeFn<T>,
    pub hash: String,
    pub label: String,
}

impl<T> Clone for ComputedDef<T> {
    fn clone(&self) -> Self {
        Self {
            f: self.f.clone(),
            hash: self.hash.clone(),
            label: self.label.clone(),
        }
    }
}

/// Without a label, the closure's type name stands in for TS `fn.toString()`.
pub fn computed<T: GraphValue, F: Fn(&QueryGet<'_>) -> T + Send + Sync + 'static>(
    f: F,
    label: Option<&str>,
) -> ComputedDef<T> {
    let hash = format!("computed-{}", IDS.fetch_add(1, Ordering::Relaxed));
    ComputedDef {
        f: Arc::new(f),
        label: label.unwrap_or(std::any::type_name::<F>()).into(),
        hash,
    }
}

impl<T> ComputedDef<T> {
    #[must_use]
    pub fn deps(mut self, deps: &str) -> Self {
        self.hash = deps.into();
        self
    }
}

impl<T: GraphValue> Queryable for ComputedDef<T> {
    type Result = T;

    fn make(&self, store: &Store) -> RcRef<T> {
        with_rc_map(store, &self.hash, || {
            let dependencies: Arc<Mutex<Vec<RcDeref>>> = Arc::default();
            let (f, deps, label) = (self.f.clone(), dependencies.clone(), self.label.clone());
            let thunk = store.inner.graph.make_thunk(
                move |get| {
                    let _span = tracing::debug_span!("js", "otel.name" = format!("js:{label}").as_str()).entered();
                    let store = context_store(get);
                    let started = std::time::Instant::now();
                    let result = f(&QueryGet { get, store, dependencies: &deps });
                    get.set_debug_info(json!({ "_tag": "computed", "label": label, "durationMs": started.elapsed().as_secs_f64() * 1000.0 }));
                    result
                },
                RefOptions { label: Some(format!("{}:results", self.label)), meta: Some(json!({ "liveStoreThunkType": "computed" })), equal: None },
            );
            Arc::new(new_query(
                store,
                LiveQueryKind::Computed,
                &self.hash,
                &self.label,
                Results::Thunk(thunk),
                vec![],
                Some(dependencies),
            ))
        })
    }
}

// queryDb

pub type Decoder<T> = Arc<dyn Fn(Vec<Row>) -> Result<T, String> + Send + Sync>;
type BeforeFirstRun = Arc<dyn Fn(&Store) + Send + Sync>;

/// `QueryInputRaw`: SQL, binds, the decoder standing in for the result schema, optional queried tables.
pub struct QueryInput<T> {
    pub query: String,
    pub bind_values: Vec<SqlValue>,
    pub queried_tables: Option<TableSet>,
    decode: Decoder<T>,
    label: Option<String>,
    exec_before_first_run: Option<BeforeFirstRun>,
}

impl<T> Clone for QueryInput<T> {
    fn clone(&self) -> Self {
        Self {
            query: self.query.clone(),
            bind_values: self.bind_values.clone(),
            queried_tables: self.queried_tables.clone(),
            decode: self.decode.clone(),
            label: self.label.clone(),
            exec_before_first_run: self.exec_before_first_run.clone(),
        }
    }
}

/// Like the TS thunk `equal`: same SQL and binds.
impl<T> PartialEq for QueryInput<T> {
    fn eq(&self, other: &Self) -> bool {
        self.query == other.query && self.bind_values == other.bind_values
    }
}

impl<T> Serialize for QueryInput<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("QueryInput", 2)?;
        st.serialize_field("query", &self.query)?;
        st.serialize_field("bindValues", &self.bind_values)?;
        st.end()
    }
}

impl QueryInput<Vec<Row>> {
    /// Raw SQL returning the rows as JSON objects.
    pub fn sql(query: &str) -> Self {
        Self::new(query, vec![], Arc::new(Ok))
    }
}

impl<T: GraphValue> QueryInput<T> {
    pub fn new(query: &str, bind_values: Vec<SqlValue>, decode: Decoder<T>) -> Self {
        Self {
            query: query.into(),
            bind_values,
            queried_tables: None,
            decode,
            label: None,
            exec_before_first_run: None,
        }
    }

    #[must_use]
    pub fn queried_tables(mut self, tables: &[&str]) -> Self {
        self.queried_tables = Some(
            tables
                .iter()
                .map(std::string::ToString::to_string)
                .collect(),
        );
        self
    }

    #[must_use]
    pub fn exec_before_first_run(mut self, f: impl Fn(&Store) + Send + Sync + 'static) -> Self {
        self.exec_before_first_run = Some(Arc::new(f));
        self
    }

    /// Decodes the result rows (`Schema.decode`).
    ///
    /// # Panics
    ///
    /// Panics when the rows do not match the result schema (a defect, as in TS).
    #[must_use]
    pub fn decode(&self, rows: Vec<Row>) -> T {
        (self.decode)(rows).unwrap_or_else(|e| panic!("This should never happen: Error parsing SQL query result.\n\nQuery: {}\n\nError: {e}", self.query))
    }

    pub fn map<U: GraphValue>(self, f: impl Fn(T) -> U + Send + Sync + 'static) -> QueryInput<U> {
        let decode = self.decode;
        QueryInput {
            query: self.query,
            bind_values: self.bind_values,
            queried_tables: self.queried_tables,
            decode: Arc::new(move |rows| decode(rows).map(&f)),
            label: self.label,
            exec_before_first_run: self.exec_before_first_run,
        }
    }
}

/// A query builder SELECT as query input (`fromQueryBuilder`).
impl From<&Select<'_>> for QueryInput<Value> {
    fn from(select: &Select<'_>) -> Self {
        let sql = select
            .as_sql()
            .unwrap_or_else(|e| panic!("UnknownError: Error building query: {e}"));
        let decoder = OwnedSelect::new(select);
        QueryInput {
            query: sql.query,
            bind_values: sql.bind_values,
            queried_tables: Some(sql.used_tables),
            decode: Arc::new(move |rows| decoder.decode(rows)),
            label: None,
            exec_before_first_run: None,
        }
    }
}

type DynamicInput<T> = Arc<dyn Fn(&QueryGet<'_>) -> QueryInput<T> + Send + Sync>;
type ResolveInput<T> = Arc<dyn Fn(&Get<'_, Ctx>) -> QueryInput<T> + Send + Sync>;

enum Input<T> {
    Static(QueryInput<T>),
    Dynamic(DynamicInput<T>),
}

impl<T> Clone for Input<T> {
    fn clone(&self) -> Self {
        match self {
            Input::Static(i) => Input::Static(i.clone()),
            Input::Dynamic(f) => Input::Dynamic(f.clone()),
        }
    }
}

/// `queryDb(input, { label, deps })`.
pub struct DbQueryDef<T> {
    input: Input<T>,
    pub hash: String,
    pub label: String,
}

impl<T> Clone for DbQueryDef<T> {
    fn clone(&self) -> Self {
        Self {
            input: self.input.clone(),
            hash: self.hash.clone(),
            label: self.label.clone(),
        }
    }
}

pub fn query_db<T: GraphValue>(input: impl Into<QueryInput<T>>) -> DbQueryDef<T> {
    let input = input.into();
    let binds = serde_json::to_string(&input.bind_values).unwrap_or_default();
    let hash = if input.bind_values.is_empty() {
        input.query.clone()
    } else {
        format!("{}-{binds}", input.query)
    };
    let label = input.label.clone().unwrap_or_else(|| input.query.clone());
    DbQueryDef {
        input: Input::Static(input),
        hash,
        label,
    }
}

/// `queryDb((get) => input)`: the input itself is reactive.
pub fn query_db_fn<T: GraphValue>(
    f: impl Fn(&QueryGet<'_>) -> QueryInput<T> + Send + Sync + 'static,
) -> DbQueryDef<T> {
    let hash = format!("db-fn-{}", IDS.fetch_add(1, Ordering::Relaxed));
    DbQueryDef {
        input: Input::Dynamic(Arc::new(f)),
        label: hash.clone(),
        hash,
    }
}

impl<T> DbQueryDef<T> {
    #[must_use]
    pub fn label(mut self, label: &str) -> Self {
        self.label = label.into();
        self
    }

    #[must_use]
    pub fn deps(mut self, deps: &str) -> Self {
        self.hash = deps.into();
        self
    }
}

impl<T: GraphValue> Queryable for DbQueryDef<T> {
    type Result = T;

    fn make(&self, store: &Store) -> RcRef<T> {
        with_rc_map(store, &self.hash, || make_db_query(store, self))
    }
}

/// `Doc.get(id)`: the client document's value; the default row is written (without refresh) before the
/// first run, like TS `execBeforeFirstRun`.
///
/// # Panics
///
/// Panics when no `id` is given and the document has no default id.
pub fn client_document_get(doc: &ClientDocument, id: Option<&str>) -> DbQueryDef<Value> {
    let id = id
        .map(str::to_string)
        .or_else(|| doc.default_id.clone())
        .expect("client document get needs an id");
    let schema = doc.get_result_schema();
    let decode: Decoder<Value> = Arc::new(move |rows| {
        let rows = Value::Array(rows.into_iter().map(Value::Object).collect());
        schema
            .decode(Val::from(rows))
            .map(|v| v.to_json_value())
            .map_err(|e| e.0)
    });
    let (default_doc, default_id) = (doc.clone(), id.clone());
    let input = QueryInput::new(
        &format!("SELECT * FROM '{}' WHERE id = ?", doc.name),
        vec![SqlValue::Text(id)],
        decode,
    )
    .queried_tables(&[&doc.name])
    .exec_before_first_run(move |store| {
        let id = crate::store::resolve_session_id_bind(
            &SqlValue::Text(default_id.clone()),
            store.session_id(),
        );
        let SqlValue::Text(id) = id else {
            unreachable!("text in, text out")
        };
        let exists = store.inner.db.cached_select(
            &format!("SELECT 1 FROM '{}' WHERE id = ?", default_doc.name),
            &[SqlValue::Text(id.clone())],
            None,
        );
        if exists.is_ok_and(|rows| rows.len() == 1) {
            return;
        }
        // Commit without refresh: this may run inside a computation.
        let event = default_doc.set(Val::Undefined, Some(&id));
        let options = crate::store::CommitOptions {
            label: Some(format!("{}.set:{id}", default_doc.name)),
            skip_refresh: true,
        };
        let _ = store.commit_with(options, [event]);
    });
    let label = format!(
        "{}.get:{}",
        doc.name,
        input
            .bind_values
            .first()
            .map(|b| format!("{b:?}"))
            .unwrap_or_default()
    );
    query_db(input).label(&label)
}

/// A query builder SELECT is queryable directly (`store.query(tables.todos.where(...))`).
impl Queryable for Select<'_> {
    type Result = Value;

    fn make(&self, store: &Store) -> RcRef<Value> {
        query_db(QueryInput::from(self)).make(store)
    }
}

/// `table` alone means all its rows (TS `tables.todos`).
impl Queryable for livestore_schema::Table {
    type Result = Value;

    fn make(&self, store: &Store) -> RcRef<Value> {
        self.query().make(store)
    }
}

/// A live query instance is queryable itself (no reference counting).
impl<T: GraphValue> Queryable for Arc<LiveQuery<T>> {
    type Result = T;

    fn make(&self, _store: &Store) -> RcRef<T> {
        RcRef {
            value: self.clone(),
            deref: Arc::new(|| {}),
            store: Weak::new(),
            hash: None,
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "ports TS `makeDbQuery` (query-input thunk + results thunk) as one unit"
)]
fn make_db_query<T: GraphValue>(store: &Store, def: &DbQueryDef<T>) -> Arc<LiveQuery<T>> {
    let graph = &store.inner.graph;
    let dependencies: Arc<Mutex<Vec<RcDeref>>> = Arc::default();
    let label = def.label.clone();
    let mut extra_nodes = vec![];
    let input: ResolveInput<T> = match &def.input {
        Input::Static(input) => {
            let input = input.clone();
            Arc::new(move |_| input.clone())
        }
        Input::Dynamic(f) => {
            let (f, deps) = (f.clone(), dependencies.clone());
            let input_label = format!("{label}:queryInput");
            let thunk = graph.make_thunk(
                move |get| {
                    let store = context_store(get);
                    let input = f(&QueryGet {
                        get,
                        store,
                        dependencies: &deps,
                    });
                    get.set_debug_info(
                        json!({ "_tag": "computed", "label": input_label, "query": input.query }),
                    );
                    input
                },
                RefOptions {
                    label: Some(format!("{label}:query")),
                    meta: Some(json!({ "liveStoreThunkType": "db.query" })),
                    equal: None,
                },
            );
            extra_nodes.push(thunk.id());
            Arc::new(move |get| get.get(&thunk))
        }
    };
    let queried_tables: Arc<Mutex<Option<TableSet>>> = Arc::default();
    let before_first_run_done = Arc::new(AtomicBool::new(false));
    let results_label = label.clone();
    let thunk = graph.make_thunk(
        move |get| {
            let span = tracing::debug_span!(
                "db",
                "otel.name" = Empty,
                "livestore.debugRefreshReason" = get
                    .debug_refresh_reason()
                    .and_then(RefreshReason::trace_label),
                "sql.query" = Empty,
                "sql.rowsCount" = Empty,
            )
            .entered();
            let store = context_store(get);
            let started = std::time::Instant::now();
            let input = input(get);
            if let Some(f) = &input.exec_before_first_run
                && !before_first_run_done.swap(true, Ordering::SeqCst)
            {
                f(&store);
            }
            let tables = lock(&queried_tables)
                .get_or_insert_with(|| {
                    input
                        .queried_tables
                        .clone()
                        .unwrap_or_else(|| store.inner.db.tables_used(&input.query))
                })
                .clone();
            for table in &tables {
                let table_ref = store.inner.table_refs.get(table).unwrap_or_else(|| {
                    panic!("This should never happen: No table ref found for {table}")
                });
                get.get(table_ref);
            }
            span.record("sql.query", input.query.as_str()).record(
                "otel.name",
                format!("db:{}", truncate(&input.query, 50)).as_str(),
            );
            let binds: Vec<SqlValue> = input
                .bind_values
                .iter()
                .map(|b| crate::store::resolve_session_id_bind(b, &store.inner.session.session_id))
                .collect();
            let rows = store
                .inner
                .db
                .cached_select(&input.query, &binds, Some(&tables))
                .unwrap_or_else(|e| {
                    panic!(
                        "This should never happen: SqliteError: {e}\nQuery: {}",
                        input.query
                    )
                });
            span.record("sql.rowsCount", rows.len());
            let result = input.decode(rows);
            get.set_debug_info(json!({
                "_tag": "db",
                "label": format!("{results_label}:results"),
                "query": input.query,
                "durationMs": started.elapsed().as_secs_f64() * 1000.0,
            }));
            result
        },
        RefOptions {
            label: Some(format!("{label}:results")),
            meta: Some(json!({ "liveStoreThunkType": "db.result" })),
            equal: None,
        },
    );
    Arc::new(new_query(
        store,
        LiveQueryKind::Db,
        &def.hash,
        &label,
        Results::Thunk(thunk),
        extra_nodes,
        Some(dependencies),
    ))
}

fn new_query<T>(
    store: &Store,
    kind: LiveQueryKind,
    hash: &str,
    label: &str,
    results: Results<T>,
    extra_nodes: Vec<NodeId>,
    dependencies: Option<Arc<Mutex<Vec<RcDeref>>>>,
) -> LiveQuery<T> {
    LiveQuery {
        id: IDS.fetch_add(1, Ordering::Relaxed),
        kind,
        hash: hash.into(),
        label: Mutex::new(label.into()),
        results,
        extra_nodes,
        dependencies: dependencies.unwrap_or_default(),
        destroyed: AtomicBool::new(false),
        store: Arc::downgrade(&store.inner),
    }
}

fn context_store(get: &Get<'_, Ctx>) -> Store {
    Store {
        inner: get
            .context()
            .upgrade()
            .expect("the store outlives its reactivity graph"),
    }
}

/// A [`Select`] with its table copied, so its decoder can outlive the borrowed table.
struct OwnedSelect {
    table: livestore_schema::Table,
    template: Select<'static>,
}

static NO_TABLE: std::sync::LazyLock<livestore_schema::Table> =
    std::sync::LazyLock::new(|| livestore_schema::Table::new(""));

impl OwnedSelect {
    fn new(select: &Select<'_>) -> Self {
        Self {
            table: select.table().clone(),
            template: select.rebind(&NO_TABLE),
        }
    }

    fn decode(&self, rows: Vec<Row>) -> Result<Value, String> {
        let rows = Value::Array(rows.into_iter().map(Value::Object).collect());
        self.template
            .rebind(&self.table)
            .decode_result(&rows)
            .map_err(|e| e.to_string())
    }
}

/// `sqlString.slice(0, n)` (UTF-16 units in TS; chars here).
fn truncate(s: &str, n: usize) -> &str {
    s.char_indices().nth(n).map_or(s, |(i, _)| &s[..i])
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
