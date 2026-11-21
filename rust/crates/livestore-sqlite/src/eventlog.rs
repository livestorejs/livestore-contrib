//! Eventlog DB (`leader-thread/eventlog.ts`, `system-tables/eventlog-tables.ts`).

use std::fmt::Write as _;

use livestore_core::{Event, SeqNum};
use livestore_schema::system_tables::{SYNC_STATUS_TABLE, eventlog_tables};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Value, json};

pub const UNKNOWN_EVENT_SCHEMA_HASH: i64 = -1;

/// `getSyncBackendCursorInfoForDb` result.
#[derive(Clone, Debug, PartialEq)]
pub struct PullCursorInfo {
    pub event_sequence_number: i64,
    pub metadata: Option<Value>,
}

/// `StreamEventsOptions` / `getEventsFromEventlog` query.
#[derive(Clone, Debug, Default)]
pub struct EventQuery {
    pub since: Option<SeqNum>,
    pub until: Option<SeqNum>,
    pub filter: Option<Vec<String>>,
    pub client_ids: Option<Vec<String>>,
    pub session_ids: Option<Vec<String>>,
    pub batch_size: Option<usize>,
    pub include_client_only: bool,
}

pub const STREAM_EVENTS_BATCH_SIZE_DEFAULT: usize = 100;

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    for sql in eventlog_tables()
        .iter()
        .flat_map(livestore_schema::Table::ddl)
    {
        conn.execute(&sql, [])?;
    }
    conn.execute(&format!("INSERT INTO {SYNC_STATUS_TABLE} (head) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM {SYNC_STATUS_TABLE})"), [])?;
    Ok(())
}

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn insert(
    conn: &Connection,
    event: &Event,
    schema_hash: i64,
    sync_metadata: Option<&Value>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO eventlog (seqNumGlobal, seqNumClient, seqNumRebaseGeneration, parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration, name, argsJson, clientId, sessionId, schemaHash, syncMetadataJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            event.seq_num.global,
            event.seq_num.client,
            event.seq_num.rebase_generation,
            event.parent_seq_num.global,
            event.parent_seq_num.client,
            event.parent_seq_num.rebase_generation,
            event.name,
            args_json(&event.args),
            event.client_id,
            event.session_id,
            schema_hash,
            sync_metadata_json(sync_metadata),
        ],
    )?;
    Ok(())
}

/// Deletes every generation at the given `(global, client)` positions.
///
/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn delete_events(conn: &Connection, keys: &[SeqNum]) -> rusqlite::Result<()> {
    let mut stmt =
        conn.prepare_cached("DELETE FROM eventlog WHERE seqNumGlobal = ? AND seqNumClient = ?")?;
    for k in keys {
        stmt.execute(params![k.global, k.client])?;
    }
    Ok(())
}

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn update_sync_metadata(
    conn: &Connection,
    seq_num: SeqNum,
    sync_metadata: Option<&Value>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE eventlog SET syncMetadataJson = ? WHERE seqNumGlobal = ? AND seqNumClient = ?",
        params![
            sync_metadata_json(sync_metadata),
            seq_num.global,
            seq_num.client
        ],
    )?;
    Ok(())
}

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn client_head(conn: &Connection) -> rusqlite::Result<SeqNum> {
    conn.query_row(
        "select seqNumGlobal, seqNumClient, seqNumRebaseGeneration from eventlog order by seqNumGlobal DESC, seqNumClient DESC limit 1",
        [],
        |r| Ok(SeqNum::new(r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map(|h| h.unwrap_or(SeqNum::ROOT))
}

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn backend_head(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("select head from __livestore_sync_status", [], |r| r.get(0))
        .optional()
        .map(Option::unwrap_or_default)
}

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn set_backend_head(conn: &Connection, head: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE __livestore_sync_status SET head = ?", [head])?;
    Ok(())
}

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn backend_id(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("select backendId from __livestore_sync_status", [], |r| {
        r.get(0)
    })
    .optional()
    .map(Option::flatten)
}

/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn set_backend_id(conn: &Connection, backend_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE __livestore_sync_status SET backendId = ?",
        [backend_id],
    )?;
    Ok(())
}

/// `getSyncBackendCursorInfoForDb`: `None` at head 0, else the metadata stored at the upstream head.
///
/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn cursor_info(
    conn: &Connection,
    upstream_head: i64,
) -> rusqlite::Result<Option<PullCursorInfo>> {
    if upstream_head == 0 {
        return Ok(None);
    }
    let json: Option<String> = conn
        .query_row(
            "SELECT syncMetadataJson FROM eventlog WHERE seqNumGlobal = ? ORDER BY seqNumClient ASC LIMIT 1",
            [upstream_head],
            |r| r.get(0),
        )
        .optional()?;
    Ok(Some(PullCursorInfo {
        event_sequence_number: upstream_head,
        metadata: json.and_then(|j| parse_sync_metadata(&j)),
    }))
}

/// All events strictly after `since` (position semantics, generation ignored), ascending.
///
/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn events_after(conn: &Connection, since: SeqNum) -> rusqlite::Result<Vec<Event>> {
    let sql = format!(
        "SELECT {EVENT_COLUMNS} FROM eventlog WHERE seqNumGlobal > ?1 OR (seqNumGlobal = ?1 AND seqNumClient > ?2) ORDER BY seqNumGlobal, seqNumClient"
    );
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_map(params![since.global, since.client], read_event)?
        .collect()
}

/// One `rematerializeFromEventlog` page: up to `limit` events strictly after `since`.
///
/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn events_after_limit(
    conn: &Connection,
    since: SeqNum,
    limit: usize,
) -> rusqlite::Result<Vec<Event>> {
    let sql = format!(
        "SELECT {EVENT_COLUMNS} FROM eventlog WHERE seqNumGlobal > ?1 OR (seqNumGlobal = ?1 AND seqNumClient > ?2) ORDER BY seqNumGlobal, seqNumClient LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_map(
        params![
            since.global,
            since.client,
            i64::try_from(limit).unwrap_or(i64::MAX)
        ],
        read_event,
    )?
    .collect()
}

/// `getEventsFromEventlog`.
///
/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn query_events(conn: &Connection, q: &EventQuery) -> rusqlite::Result<Vec<Event>> {
    let since = q.since.unwrap_or(SeqNum::ROOT);
    let mut sql = format!("SELECT {EVENT_COLUMNS} FROM eventlog WHERE seqNumGlobal > ?");
    let mut binds: Vec<SqlValue> = vec![since.global.into()];
    if let Some(until) = q.until {
        sql.push_str(" AND seqNumGlobal <= ?");
        binds.push(until.global.into());
    }
    for (col, values) in [
        ("name", &q.filter),
        ("clientId", &q.client_ids),
        ("sessionId", &q.session_ids),
    ] {
        if let Some(values) = values.as_ref().filter(|v| !v.is_empty()) {
            let _ = write!(
                sql,
                " AND {col} IN ({})",
                vec!["?"; values.len()].join(", ")
            );
            binds.extend(values.iter().map(|v| SqlValue::Text(v.clone())));
        }
    }
    if !q.include_client_only {
        sql.push_str(" AND seqNumClient <= 0");
    }
    sql.push_str(" ORDER BY seqNumGlobal ASC, seqNumClient ASC LIMIT ?");
    binds.push(
        i64::try_from(q.batch_size.unwrap_or(STREAM_EVENTS_BATCH_SIZE_DEFAULT))
            .unwrap_or(i64::MAX)
            .into(),
    );
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_map(params_from_iter(binds), read_event)?
        .collect()
}

/// `clearLocalDatabases` (eventlog half).
///
/// # Errors
///
/// Fails when a SQLite statement fails.
pub fn clear(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("DELETE FROM eventlog; DELETE FROM __livestore_sync_status;")
}

const EVENT_COLUMNS: &str = "seqNumGlobal, seqNumClient, seqNumRebaseGeneration, parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration, name, argsJson, clientId, sessionId";

fn read_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    let args: String = r.get(7)?;
    Ok(Event {
        seq_num: SeqNum::new(r.get(0)?, r.get(1)?, r.get(2)?),
        parent_seq_num: SeqNum::new(r.get(3)?, r.get(4)?, r.get(5)?),
        name: r.get(6)?,
        args: serde_json::from_str(&args).unwrap_or(Value::Null),
        client_id: r.get(8)?,
        session_id: r.get(9)?,
    })
}

fn args_json(args: &Value) -> String {
    if args.is_null() {
        "{}".into()
    } else {
        args.to_string()
    }
}

fn sync_metadata_json(metadata: Option<&Value>) -> String {
    match metadata {
        None => json!({"_tag": "None"}).to_string(),
        Some(value) => json!({"_tag": "Some", "value": value}).to_string(),
    }
}

fn parse_sync_metadata(json: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(json).ok()?;
    (v["_tag"] == "Some").then(|| v["value"].clone())
}
