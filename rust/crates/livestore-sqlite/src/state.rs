//! State DB: system tables, materialization with session changesets, journal, rollback, rebuild
//! (`leader-thread/materialize-event.ts`, `MaterializationJournal.ts`, `StateHead.ts`, `recreate-db.ts`).

use std::sync::Arc;

use livestore_core::{Event, SeqNum};
use livestore_schema::fingerprint::table_fingerprint;
use livestore_schema::system_tables::state_tables;
use livestore_schema::{MaterializeContext, MaterializeError, Schema, SqlValue, Table};
use rusqlite::session::{ConflictAction, ConflictType, Session, invert_strm};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::helper::with_savepoint;
use crate::{Error, eventlog};

pub const STATE_REBUILD_BATCH_SIZE_DEFAULT: usize = 100;

/// `schema.state.sqlite.migrations.hooks`; a hook error aborts the rebuild as `UnknownError`.
pub type MigrationHook = Arc<dyn Fn(&Connection) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Default)]
pub struct MigrationHooks {
    pub init: Option<MigrationHook>,
    pub pre: Option<MigrationHook>,
    pub post: Option<MigrationHook>,
}

/// `recreateDb` options: migration hooks and `stateRebuildBatchSize`.
#[derive(Clone)]
pub struct RebuildOptions {
    pub hooks: MigrationHooks,
    pub batch_size: usize,
}

impl Default for RebuildOptions {
    fn default() -> Self {
        Self {
            hooks: MigrationHooks::default(),
            batch_size: STATE_REBUILD_BATCH_SIZE_DEFAULT,
        }
    }
}

const SYSTEM_TABLES: &[&str] = &[
    "__livestore_schema",
    "__livestore_schema_event_defs",
    "__livestore_state_head",
    "__livestore_materialization_journal",
    "__livestore_rebuild",
];

/// All system tables plus the rebuild marker exist (`hasCompletedState`).
pub fn has_completed_state(conn: &Connection) -> rusqlite::Result<bool> {
    for table in SYSTEM_TABLES {
        let exists: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
            [table],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(false);
        }
    }
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM __livestore_rebuild WHERE id = 1)",
        [],
        |r| r.get(0),
    )
}

/// `recreateDb`: drops every table, runs the hooks around `migrateDb`, replays the eventlog in batches
/// (each its own savepoint, so a failure keeps the committed batches) and only then marks the state complete.
pub fn rebuild(
    conn: &Connection,
    eventlog_conn: &Connection,
    schema: &Schema,
    options: &RebuildOptions,
) -> Result<(), Error> {
    drop_all_tables(conn)?;
    run_hook(&options.hooks.init, conn)?;
    migrate(conn, schema)?;
    run_hook(&options.hooks.pre, conn)?;
    let mut cursor = SeqNum::ROOT;
    loop {
        let batch = eventlog::events_after_limit(eventlog_conn, cursor, options.batch_size)?;
        let Some(last) = batch.last() else { break };
        cursor = last.seq_num;
        with_savepoint(conn, || {
            batch
                .iter()
                .try_for_each(|event| materialize(conn, schema, event).map(drop))
        })?;
    }
    run_hook(&options.hooks.post, conn)?;
    mark_completed(conn)?;
    Ok(())
}

/// `migrateDb`: creates the system and app tables and records table and event definitions.
pub fn migrate(conn: &Connection, schema: &Schema) -> Result<(), Error> {
    let tables: Vec<Table> = state_tables()
        .into_iter()
        .chain(schema.tables().iter().cloned())
        .collect();
    for sql in tables.iter().flat_map(Table::ddl) {
        conn.execute(&sql, [])?;
    }
    let now = now_millis();
    for table in &tables {
        conn.execute(
            "INSERT OR REPLACE INTO __livestore_schema (tableName, schemaHash, updatedAt) VALUES (?, ?, ?)",
            params![table.name, table_fingerprint(table), now],
        )?;
    }
    for event in schema.events() {
        conn.execute(
            "INSERT OR REPLACE INTO __livestore_schema_event_defs (eventName, schemaHash, updatedAt) VALUES (?, ?, ?)",
            params![event.name, event.schema_hash, now],
        )?;
    }
    Ok(())
}

/// `markStateAsCompleted`.
pub fn mark_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO __livestore_rebuild (id) VALUES (1)",
        [],
    )?;
    Ok(())
}

/// `clearLocalDatabases` (state half): drops every table; the next boot rebuilds.
pub fn drop_all_tables(conn: &Connection) -> rusqlite::Result<()> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for t in tables {
        conn.execute(&format!("DROP TABLE IF EXISTS \"{t}\""), [])?;
    }
    Ok(())
}

/// Applies one event to the state DB in a savepoint and journals its changeset. Unknown events only
/// advance the head and journal a NULL changeset. Returns the schema hash for the eventlog row.
#[tracing::instrument(name = "@livestore/common:leader-thread:materializeEvent", skip_all, fields(event = %event.name, seq_num = %event.seq_num))]
pub fn materialize(conn: &Connection, schema: &Schema, event: &Event) -> Result<i64, Error> {
    with_savepoint(conn, || -> Result<(), Error> {
        let changeset = if let Some(materializer) = schema.resolve(event, "materialize")? {
            let query = |sql: &str, binds: &[SqlValue]| {
                crate::db::query_rows_with(conn, sql, binds)
                    .map(|rows| rows.into_iter().map(serde_json::Value::Object).collect())
                    .map_err(|e| MaterializeError::Other(e.to_string()))
            };
            let statements = materializer(
                &event.args,
                &MaterializeContext {
                    event,
                    query: Some(&query),
                },
            )?;
            let mut session = Session::new(conn)?;
            session.attach::<&str>(None)?;
            for s in statements {
                conn.execute(&s.sql, params_from_iter(s.binds.iter().map(to_sql)))?;
            }
            let mut bytes = Vec::new();
            session.changeset_strm(&mut bytes)?;
            // wa-sqlite reports an empty changeset as NULL.
            (!bytes.is_empty()).then_some(bytes)
        } else {
            None
        };
        journal_record(conn, event.seq_num, changeset.as_deref())?;
        set_head(conn, event.seq_num)?;
        Ok(())
    })?;
    Ok(event_schema_hash(schema, &event.name))
}

pub fn head(conn: &Connection) -> rusqlite::Result<SeqNum> {
    conn.query_row(
        "SELECT seqNumGlobal, seqNumClient, seqNumRebaseGeneration FROM __livestore_state_head WHERE id = 1",
        [],
        |r| Ok(SeqNum::new(r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map(|h| h.unwrap_or(SeqNum::ROOT))
}

pub fn set_head(conn: &Connection, head: SeqNum) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO __livestore_state_head (id, seqNumGlobal, seqNumClient, seqNumRebaseGeneration) VALUES (1, ?, ?, ?)",
        params![head.global, head.client, head.rebase_generation],
    )?;
    Ok(())
}

/// Undoes journaled events newest-first via inverted changesets, then deletes their journal rows.
/// Fails with `MaterializationJournalError` (method `rollback`) without changing anything when a key is missing
/// or a changeset cannot be applied.
pub fn rollback(conn: &Connection, keys: &[SeqNum]) -> Result<(), Error> {
    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| b.compare(a));
    with_savepoint(conn, || rollback_sorted(conn, &sorted)).map_err(|e| match e {
        Error::MaterializationJournal(_) => e,
        other => Error::MaterializationJournal(format!("rollback: {other}")),
    })
}

fn rollback_sorted(conn: &Connection, sorted: &[SeqNum]) -> Result<(), Error> {
    let mut changesets = Vec::with_capacity(sorted.len());
    for k in sorted {
        let changeset: Option<Vec<u8>> = conn
            .query_row(
                "SELECT changeset FROM __livestore_materialization_journal WHERE seqNumGlobal = ? AND seqNumClient = ? AND seqNumRebaseGeneration = ? LIMIT 1",
                params![k.global, k.client, k.rebase_generation],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::MaterializationJournal(format!("rollback: Missing materialization journal record for {k}")))?;
        changesets.push(changeset);
    }
    for changeset in changesets.into_iter().flatten() {
        let mut inverted = Vec::new();
        invert_strm(&mut changeset.as_slice(), &mut inverted)?;
        conn.apply_strm(
            &mut inverted.as_slice(),
            None::<fn(&str) -> bool>,
            |conflict, _| match conflict {
                ConflictType::SQLITE_CHANGESET_DATA | ConflictType::SQLITE_CHANGESET_CONFLICT => {
                    ConflictAction::SQLITE_CHANGESET_REPLACE
                }
                _ => ConflictAction::SQLITE_CHANGESET_OMIT,
            },
        )?;
    }
    let mut delete = conn.prepare_cached(
        "DELETE FROM __livestore_materialization_journal WHERE seqNumGlobal = ? AND seqNumClient = ? AND seqNumRebaseGeneration = ?",
    )?;
    for k in sorted {
        delete.execute(params![k.global, k.client, k.rebase_generation])?;
    }
    Ok(())
}

/// Drops journal rows at or before `key` (they can no longer be rolled back).
pub fn discard_journal_up_to(conn: &Connection, key: SeqNum) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM __livestore_materialization_journal WHERE seqNumGlobal < ?1 OR (seqNumGlobal = ?1 AND seqNumClient <= ?2)",
        params![key.global, key.client],
    )?;
    Ok(())
}

/// `MaterializationJournal.record`: replaces any row at the exact key.
pub fn journal_record(
    conn: &Connection,
    key: SeqNum,
    changeset: Option<&[u8]>,
) -> rusqlite::Result<()> {
    let k = params![key.global, key.client, key.rebase_generation];
    conn.execute(
        "DELETE FROM __livestore_materialization_journal WHERE seqNumGlobal = ? AND seqNumClient = ? AND seqNumRebaseGeneration = ?",
        k,
    )?;
    conn.execute(
        "INSERT INTO __livestore_materialization_journal (seqNumGlobal, seqNumClient, seqNumRebaseGeneration, changeset) VALUES (?, ?, ?, ?)",
        params![key.global, key.client, key.rebase_generation, changeset],
    )?;
    Ok(())
}

fn run_hook(hook: &Option<MigrationHook>, conn: &Connection) -> Result<(), Error> {
    match hook {
        Some(hook) => hook(conn).map_err(Error::Unknown),
        None => Ok(()),
    }
}

fn event_schema_hash(schema: &Schema, name: &str) -> i64 {
    schema
        .event(name)
        .map_or(eventlog::UNKNOWN_EVENT_SCHEMA_HASH, |e| {
            i64::from(e.schema_hash)
        })
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

fn stable_hash(s: &str) -> i64 {
    let h = s.bytes().fold(0x811c9dc5u32, |h, b| {
        (h ^ b as u32).wrapping_mul(0x01000193)
    });
    h as i32 as i64
}

fn now_millis() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    ms.to_string()
}

/// `hashMaterializerResults`: a stable hash of a materializer's statements, compared between leader
/// and session to catch side-effecting materializers.
pub fn materializer_hash(statements: &[livestore_schema::SqlStatement]) -> i64 {
    let text: Vec<String> = statements
        .iter()
        .map(|s| {
            format!(
                "{}\u{0}{}",
                s.sql,
                serde_json::to_string(&s.binds).unwrap_or_default()
            )
        })
        .collect();
    stable_hash(&text.join("\u{1}"))
}
