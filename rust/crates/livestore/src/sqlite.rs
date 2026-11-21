//! `SqliteDbWrapper`: the session's state DB with a statement-result cache invalidated per table,
//! `getTablesUsed`, changesets and per-frame debug counters.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use livestore_schema::SqlValue;
use livestore_sqlite::Row;
use parking_lot::ReentrantMutex;
use rusqlite::session::{ConflictAction, ConflictType, Session, invert_strm};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, MAIN_DB, params_from_iter};
use serde_json::{Map, Value};
use tracing::field::Empty;

pub type TableSet = BTreeSet<String>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DebugInfo {
    pub query_frame_duration: f64,
    pub query_frame_count: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ExecuteOptions {
    pub has_no_effects: bool,
    pub write_tables: Option<TableSet>,
}

static SAVEPOINT_IDS: AtomicU64 = AtomicU64::new(0);

/// `configureSQLite`, byte-identical to TS (it is the `sql.query` of the store's first traced statement).
const CONFIGURE_SQL: &str = "
      PRAGMA page_size=32768;
      PRAGMA cache_size=10000;
      PRAGMA synchronous='OFF';
      PRAGMA temp_store='MEMORY';
      PRAGMA foreign_keys='ON'; -- we want foreign key constraints to be enforced
    ";

/// The connection is behind a reentrant lock so a changeset session can stay open while the
/// callback executes statements through the same wrapper.
pub struct SqliteDbWrapper {
    conn: ReentrantMutex<Connection>,
    cache: Mutex<QueryCache>,
    tables_used_cache: Mutex<HashMap<String, TableSet>>,
    debug_info: Mutex<DebugInfo>,
}

impl SqliteDbWrapper {
    /// # Errors
    ///
    /// Fails when SQLite rejects the connection pragmas.
    pub fn new(conn: Connection) -> rusqlite::Result<Self> {
        livestore_sqlite::configure_connection(&conn)?;
        Ok(Self {
            conn: ReentrantMutex::new(conn),
            cache: Mutex::new(QueryCache::default()),
            tables_used_cache: Mutex::new(HashMap::new()),
            debug_info: Mutex::new(DebugInfo::default()),
        })
    }

    /// `configureSQLite`: run by the Store when it wraps the session DB.
    ///
    /// # Errors
    ///
    /// Fails when SQLite rejects one of the pragmas.
    pub fn configure(&self) -> rusqlite::Result<()> {
        self.execute(CONFIGURE_SQL)
    }

    /// # Errors
    ///
    /// Fails when SQLite cannot open or configure the in-memory database.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::new(Connection::open_in_memory()?)
    }

    /// A fresh in-memory DB holding the given `export()` bytes.
    ///
    /// # Errors
    ///
    /// Fails when the bytes are not a valid SQLite database image.
    pub fn from_snapshot(bytes: &[u8]) -> rusqlite::Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        conn.deserialize_read_exact(MAIN_DB, bytes, bytes.len(), false)?;
        Self::new(conn)
    }

    /// Runs `f` with the raw connection (bypasses the cache; call [`Self::clear_cache`] after writes).
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        f(&self.conn.lock())
    }

    /// `execute`: one or more statements without binds.
    ///
    /// # Errors
    ///
    /// Fails when SQLite cannot prepare or run a statement.
    pub fn execute(&self, sql: &str) -> rusqlite::Result<()> {
        self.cached_execute(sql, &[], ExecuteOptions::default())
            .map(|_| ())
    }

    /// `cachedExecute`: returns the duration in ms.
    ///
    /// # Errors
    ///
    /// Fails when SQLite cannot prepare or run a statement.
    pub fn cached_execute(
        &self,
        sql: &str,
        binds: &[SqlValue],
        options: ExecuteOptions,
    ) -> rusqlite::Result<f64> {
        let _span =
            tracing::debug_span!("livestore.in-memory-db:execute", "sql.query" = sql).entered();
        let start = Instant::now();
        {
            let conn = self.conn.lock();
            if binds.is_empty() && !is_single_statement(sql) {
                conn.execute_batch(sql)?;
            } else {
                conn.prepare_cached(sql)?
                    .execute(params_from_iter(binds.iter().map(to_sql)))?;
            }
        }
        if starts_with_word(sql, "rollback") {
            self.clear_cache();
        } else if !options.has_no_effects && !QueryCache::ignore_query(sql) {
            let tables = options
                .write_tables
                .unwrap_or_else(|| self.tables_used(sql));
            lock(&self.cache).invalidate(&tables);
        }
        Ok(self.record_frame(start))
    }

    /// `select`: rows as JSON objects (column order kept).
    ///
    /// # Errors
    ///
    /// Fails when SQLite cannot prepare or run the query.
    pub fn select(&self, sql: &str, binds: &[SqlValue]) -> rusqlite::Result<Vec<Row>> {
        self.cached_select(sql, binds, None)
    }

    /// `cachedSelect`.
    ///
    /// # Errors
    ///
    /// Fails when SQLite cannot prepare or run the query.
    pub fn cached_select(
        &self,
        sql: &str,
        binds: &[SqlValue],
        queried_tables: Option<&TableSet>,
    ) -> rusqlite::Result<Vec<Row>> {
        let span = tracing::debug_span!(
            "sql-in-memory-select",
            "sql.query" = sql,
            "sql.rowsCount" = Empty,
            "sql.cached" = Empty
        )
        .entered();
        let key = QueryCache::key(sql, binds);
        if let Some(hit) = lock(&self.cache).get(&key) {
            span.record("sql.rowsCount", hit.len())
                .record("sql.cached", true);
            return Ok(hit);
        }
        let start = Instant::now();
        let rows = {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare_cached(sql)?;
            let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
            let rows = stmt.query_map(params_from_iter(binds.iter().map(to_sql)), |r| {
                let mut row = Map::new();
                for (i, name) in names.iter().enumerate() {
                    row.insert(name.clone(), from_sql(r.get_ref(i)?));
                }
                Ok(row)
            })?;
            rows.collect::<rusqlite::Result<Vec<Row>>>()?
        };
        span.record("sql.rowsCount", rows.len())
            .record("sql.cached", false);
        let tables = queried_tables
            .cloned()
            .unwrap_or_else(|| self.tables_used(sql));
        lock(&self.cache).set(tables, key, rows.clone());
        self.record_frame(start);
        Ok(rows)
    }

    /// `getTablesUsed`: user tables a statement reads or writes, from the `OpenRead`/`OpenWrite` opcodes of
    /// its plan (stands in for wa-sqlite's `tables_used` virtual table). Invalid statements use no tables.
    pub fn tables_used(&self, sql: &str) -> TableSet {
        if let Some(table) = plain_delete_table(sql) {
            return [table].into();
        }
        if let Some(hit) = lock(&self.tables_used_cache).get(sql) {
            return hit.clone();
        }
        let tables = self
            .with_conn(|conn| explain_tables(conn, sql))
            .unwrap_or_default();
        lock(&self.tables_used_cache).insert(sql.into(), tables.clone());
        tables
    }

    /// `withChangeset`: records what `f` changes.
    ///
    /// # Errors
    ///
    /// Fails when `f` fails, or when the SQLite session cannot be created or serialized.
    pub fn with_changeset<T, E: From<rusqlite::Error>>(
        &self,
        f: impl FnOnce() -> Result<T, E>,
    ) -> Result<(T, Option<Vec<u8>>), E> {
        let conn = self.conn.lock();
        let mut session = Session::new(&conn)?;
        session.attach::<&str>(None)?;
        let result = f()?;
        let mut bytes = Vec::new();
        session.changeset_strm(&mut bytes)?;
        Ok((result, (!bytes.is_empty()).then_some(bytes)))
    }

    pub fn make_changeset(&self, data: Vec<u8>) -> Changeset<'_> {
        Changeset { db: self, data }
    }

    /// `SAVEPOINT` with a unique name; finish with [`Self::release_savepoint`] or [`Self::rollback_savepoint`].
    ///
    /// # Errors
    ///
    /// Fails when SQLite rejects the `SAVEPOINT` statement.
    pub fn begin_savepoint(&self) -> rusqlite::Result<String> {
        let name = format!(
            "livestore_savepoint_{}",
            SAVEPOINT_IDS.fetch_add(1, Ordering::Relaxed)
        );
        self.conn
            .lock()
            .execute_batch(&format!("SAVEPOINT {name}"))?;
        Ok(name)
    }

    /// # Errors
    ///
    /// Fails when no savepoint with that name is open.
    pub fn release_savepoint(&self, name: &str) -> rusqlite::Result<()> {
        self.conn.lock().execute_batch(&format!("RELEASE {name}"))
    }

    /// # Errors
    ///
    /// Fails when no savepoint with that name is open.
    pub fn rollback_savepoint(&self, name: &str) -> rusqlite::Result<()> {
        let result = self
            .conn
            .lock()
            .execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
        self.clear_cache();
        result
    }

    /// Drops every cached result (rollbacks bypass statement-level invalidation).
    pub fn clear_cache(&self) {
        *lock(&self.cache) = QueryCache::default();
    }

    /// # Errors
    ///
    /// Fails when SQLite cannot serialize the database.
    pub fn export(&self) -> rusqlite::Result<Vec<u8>> {
        Ok(self.conn.lock().serialize(MAIN_DB)?.to_vec())
    }

    pub fn debug_info(&self) -> DebugInfo {
        lock(&self.debug_info).clone()
    }

    fn record_frame(&self, start: Instant) -> f64 {
        let duration = start.elapsed().as_secs_f64() * 1000.0;
        let mut info = lock(&self.debug_info);
        info.query_frame_duration += duration;
        info.query_frame_count += 1;
        duration
    }
}

/// `SqliteDbChangeset`.
pub struct Changeset<'a> {
    db: &'a SqliteDbWrapper,
    data: Vec<u8>,
}

impl Changeset<'_> {
    /// # Errors
    ///
    /// Fails when the changeset bytes are malformed.
    pub fn invert(self) -> rusqlite::Result<Self> {
        let mut inverted = Vec::new();
        invert_strm(&mut self.data.as_slice(), &mut inverted)?;
        Ok(Changeset {
            db: self.db,
            data: inverted,
        })
    }

    /// # Errors
    ///
    /// Fails when the changeset bytes are malformed or SQLite cannot apply them.
    pub fn apply(self) -> rusqlite::Result<()> {
        let result = self.db.with_conn(|conn| {
            conn.apply_strm(
                &mut self.data.as_slice(),
                None::<fn(&str) -> bool>,
                |conflict, _| match conflict {
                    ConflictType::SQLITE_CHANGESET_DATA
                    | ConflictType::SQLITE_CHANGESET_CONFLICT => {
                        ConflictAction::SQLITE_CHANGESET_REPLACE
                    }
                    _ => ConflictAction::SQLITE_CHANGESET_OMIT,
                },
            )
        });
        self.db.clear_cache();
        result
    }
}

/// Results keyed by statement and binds, invalidated by the tables they read.
#[derive(Default)]
struct QueryCache {
    entries: HashMap<String, (TableSet, Vec<Row>)>,
}

impl QueryCache {
    fn key(sql: &str, binds: &[SqlValue]) -> String {
        format!(
            "{sql}\u{0}{}",
            serde_json::to_string(binds).unwrap_or_default()
        )
    }

    fn get(&self, key: &str) -> Option<Vec<Row>> {
        self.entries.get(key).map(|(_, rows)| rows.clone())
    }

    fn set(&mut self, tables: TableSet, key: String, rows: Vec<Row>) {
        self.entries.insert(key, (tables, rows));
    }

    fn invalidate(&mut self, tables: &TableSet) {
        self.entries.retain(|_, (used, _)| used.is_disjoint(tables));
    }

    /// Statements that never change user data (savepoints, transactions, pragmas).
    fn ignore_query(sql: &str) -> bool {
        ["savepoint", "release", "begin", "commit", "pragma"]
            .iter()
            .any(|w| starts_with_word(sql, w))
    }
}

fn explain_tables(conn: &Connection, sql: &str) -> rusqlite::Result<TableSet> {
    let pages: HashMap<i64, String> = conn
        .prepare_cached("SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare(&format!("EXPLAIN {sql}"))?;
    let nulls = vec![rusqlite::types::Null; stmt.parameter_count()];
    let mut rows = stmt.query(params_from_iter(nulls))?;
    let mut tables = TableSet::new();
    while let Some(row) = rows.next()? {
        let opcode: String = row.get("opcode")?;
        let (p2, p3): (i64, i64) = (row.get("p2")?, row.get("p3")?);
        if (opcode == "OpenRead" || opcode == "OpenWrite")
            && p3 == 0
            && let Some(table) = pages.get(&p2)
        {
            tables.insert(table.clone());
        }
    }
    Ok(tables)
}

fn plain_delete_table(sql: &str) -> Option<String> {
    let words: Vec<&str> = sql.split_whitespace().collect();
    match words.as_slice() {
        [d, f, table]
            if d.eq_ignore_ascii_case("delete")
                && f.eq_ignore_ascii_case("from")
                && table.chars().all(|c| c.is_alphanumeric() || c == '_') =>
        {
            Some((*table).into())
        }
        _ => None,
    }
}

fn starts_with_word(sql: &str, word: &str) -> bool {
    let sql = sql.trim_start();
    sql.len() >= word.len()
        && sql[..word.len()].eq_ignore_ascii_case(word)
        && sql[word.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric() && c != '_')
}

fn is_single_statement(sql: &str) -> bool {
    !sql.trim().trim_end_matches(';').contains(';')
}

pub(crate) fn to_sql(v: &SqlValue) -> rusqlite::types::Value {
    match v {
        SqlValue::Null => rusqlite::types::Value::Null,
        SqlValue::Integer(i) => (*i).into(),
        SqlValue::Real(f) => (*f).into(),
        SqlValue::Text(s) => s.clone().into(),
        SqlValue::Blob(b) => b.clone().into(),
    }
}

fn from_sql(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => n.into(),
        ValueRef::Real(f) => f.into(),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into(),
        ValueRef::Blob(b) => b.iter().map(|x| Value::from(*x)).collect(),
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
