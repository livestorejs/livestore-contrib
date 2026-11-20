//! `LeaderPersistence` over the two leader databases: boot, durable local and upstream commits.
//! Holds no sync state; the sync processor (or [`crate::LocalLeader`]) owns it.

use std::path::Path;
use std::sync::Arc;

use livestore_core::{Event, SeqNum, SyncState};
use livestore_schema::Schema;
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use livestore_schema::MaterializeError;

use crate::eventlog::{self, EventQuery, PullCursorInfo};
use crate::state::RebuildOptions;
use crate::{Error, Result, state};

/// An event received from the backend together with its sync metadata (`LeaderPersistence.PulledEvent`).
#[derive(Clone, Debug, PartialEq)]
pub struct PulledEvent {
    pub event: Event,
    pub sync_metadata: Option<Value>,
}

/// What a durable commit wrote (`LeaderPersistence` receipt).
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub persisted_events: Vec<Event>,
    pub state_head: SeqNum,
    pub backend_head: Option<SeqNum>,
    pub rolled_back_event_nums: Vec<SeqNum>,
}

/// Boot inputs besides the schema: rebuild options and an adapter's `importSnapshot` (a serialized state DB).
#[derive(Clone, Default)]
pub struct BootOptions {
    pub rebuild: RebuildOptions,
    pub import_snapshot: Option<Vec<u8>>,
}

/// `persistUpstream` input.
pub struct UpstreamCommit<'a> {
    pub pulled_events: &'a [PulledEvent],
    pub events: &'a [Event],
    pub rollback_events: &'a [Event],
    pub confirmed_events: &'a [Event],
    pub backend_head: SeqNum,
}

pub type Row = Map<String, Value>;

pub struct LeaderDb {
    state: Connection,
    eventlog: Connection,
    schema: Arc<Schema>,
    rebuild: RebuildOptions,
}

impl LeaderDb {
    pub fn open(
        state_path: impl AsRef<Path>,
        eventlog_path: impl AsRef<Path>,
        schema: Arc<Schema>,
    ) -> Result<Self> {
        Self::boot(
            Connection::open(state_path)?,
            Connection::open(eventlog_path)?,
            schema,
        )
    }

    pub fn open_in_memory(schema: Arc<Schema>) -> Result<Self> {
        Self::boot(
            Connection::open_in_memory()?,
            Connection::open_in_memory()?,
            schema,
        )
    }

    fn boot(state: Connection, eventlog: Connection, schema: Arc<Schema>) -> Result<Self> {
        Self::boot_with(state, eventlog, schema, BootOptions::default())
    }

    /// Boot half of `makeLeaderThreadLayer`: import a snapshot (migrated and marked complete, like the in-memory
    /// adapter), init the eventlog, rebuild incomplete state.
    pub fn boot_with(
        mut state: Connection,
        eventlog: Connection,
        schema: Arc<Schema>,
        options: BootOptions,
    ) -> Result<Self> {
        crate::configure_connection(&state)?;
        crate::configure_connection(&eventlog)?;
        if let Some(snapshot) = &options.import_snapshot {
            state.deserialize_read_exact("main", snapshot.as_slice(), snapshot.len(), false)?;
            state::migrate(&state, &schema)?;
            state::mark_completed(&state)?;
        }
        eventlog::init(&eventlog)?;
        if !state::has_completed_state(&state)? {
            state::rebuild(&state, &eventlog, &schema, &options.rebuild)?;
        }
        Ok(Self {
            state,
            eventlog,
            schema,
            rebuild: options.rebuild,
        })
    }

    pub fn schema(&self) -> &Arc<Schema> {
        &self.schema
    }

    /// `getInitialSyncState`: pending = rows after the backend head.
    pub fn initial_sync_state(&self) -> Result<SyncState> {
        let backend_head = eventlog::backend_head(&self.eventlog)?;
        let local_head = eventlog::client_head(&self.eventlog)?;
        if backend_head > local_head.global {
            return Err(Error::Invariant(format!(
                "During boot the backend head ({backend_head}) should never be greater than the local head ({})",
                local_head.global
            )));
        }
        let upstream_head = SeqNum::new(backend_head, 0, 0);
        let pending = eventlog::events_after(&self.eventlog, upstream_head)?;
        Ok(SyncState {
            pending,
            upstream_head,
            local_head,
        })
    }

    /// `persistLocal`: materialize and append a local batch atomically over both DBs.
    pub fn persist_local(&self, events: &[Event]) -> Result<Receipt> {
        self.in_transaction(|| {
            for e in events {
                self.materialize(e, None)?;
            }
            Ok(())
        })?;
        Ok(Receipt {
            persisted_events: events.to_vec(),
            state_head: state::head(&self.state)?,
            backend_head: None,
            rolled_back_event_nums: vec![],
        })
    }

    /// `persistUpstream`: rollback + eventlog delete, materialize the new events, write confirmation
    /// metadata, trim the journal and advance the backend head, in one transaction over both DBs.
    pub fn persist_upstream(&self, c: UpstreamCommit<'_>) -> Result<Receipt> {
        self.in_transaction(|| {
            if let Some(first) = c.rollback_events.first() {
                let keys: Vec<SeqNum> = c.rollback_events.iter().map(|e| e.seq_num).collect();
                state::rollback(&self.state, &keys)?;
                state::set_head(&self.state, first.parent_seq_num)?;
                eventlog::delete_events(&self.eventlog, &keys)?;
            }
            for e in c.events {
                let metadata = c
                    .pulled_events
                    .iter()
                    .find(|p| p.event.seq_num == e.seq_num)
                    .and_then(|p| p.sync_metadata.as_ref());
                self.materialize(e, metadata)?;
            }
            for p in c.pulled_events.iter().filter(|p| {
                c.confirmed_events
                    .iter()
                    .any(|e| same_position(e.seq_num, p.event.seq_num))
            }) {
                eventlog::update_sync_metadata(
                    &self.eventlog,
                    p.event.seq_num,
                    p.sync_metadata.as_ref(),
                )?;
            }
            state::discard_journal_up_to(&self.state, c.backend_head)?;
            eventlog::set_backend_head(&self.eventlog, c.backend_head.global)?;
            Ok(())
        })?;
        Ok(Receipt {
            persisted_events: c.events.to_vec(),
            state_head: state::head(&self.state)?,
            backend_head: Some(SeqNum::new(eventlog::backend_head(&self.eventlog)?, 0, 0)),
            rolled_back_event_nums: c.rollback_events.iter().map(|e| e.seq_num).collect(),
        })
    }

    /// Wipes the state DB and replays the eventlog (what boot does after a schema change).
    pub fn rebuild_state(&self) -> Result<()> {
        state::rebuild(&self.state, &self.eventlog, &self.schema, &self.rebuild)
    }

    /// `clearLocalDatabases`: empty the eventlog and sync status, drop all state tables.
    pub fn clear_for_reset(&self) -> Result<()> {
        eventlog::clear(&self.eventlog)?;
        state::drop_all_tables(&self.state)?;
        Ok(())
    }

    pub fn cursor_info(&self, upstream_head: i64) -> Result<Option<PullCursorInfo>> {
        Ok(eventlog::cursor_info(&self.eventlog, upstream_head)?)
    }

    pub fn query_events(&self, query: &EventQuery) -> Result<Vec<Event>> {
        Ok(eventlog::query_events(&self.eventlog, query)?)
    }

    pub fn backend_id(&self) -> Result<Option<String>> {
        Ok(eventlog::backend_id(&self.eventlog)?)
    }

    pub fn set_backend_id(&self, backend_id: &str) -> Result<()> {
        Ok(eventlog::set_backend_id(&self.eventlog, backend_id)?)
    }

    pub fn state_head(&self) -> Result<SeqNum> {
        Ok(state::head(&self.state)?)
    }

    pub fn state_conn(&self) -> &Connection {
        &self.state
    }

    pub fn eventlog_conn(&self) -> &Connection {
        &self.eventlog
    }

    /// Runs a read query on the state DB and returns JSON rows.
    pub fn query(&self, sql: &str) -> Result<Vec<Row>> {
        query_rows(&self.state, sql)
    }

    fn materialize(&self, event: &Event, sync_metadata: Option<&Value>) -> Result<()> {
        materialize_event(
            &self.state,
            &self.eventlog,
            &self.schema,
            event,
            false,
            sync_metadata,
        )
    }

    /// `withCoordinatedTransactions`: commit state first, then eventlog; roll back both on failure. Failures other
    /// than journal and unknown-event errors surface as `MaterializeError`, like TS.
    fn in_transaction(&self, f: impl FnOnce() -> Result<()>) -> Result<()> {
        self.in_transaction_raw(f).map_err(|e| match e {
            Error::Materialize(_) | Error::MaterializationJournal(_) | Error::UnknownEvent(_) => e,
            other => Error::Materialize(MaterializeError::Other(other.to_string())),
        })
    }

    fn in_transaction_raw(&self, f: impl FnOnce() -> Result<()>) -> Result<()> {
        self.state.execute_batch("BEGIN")?;
        if let Err(e) = self.eventlog.execute_batch("BEGIN") {
            self.state.execute_batch("ROLLBACK")?;
            return Err(e.into());
        }
        let result = f().and_then(|()| {
            self.state.execute_batch("COMMIT")?;
            self.eventlog.execute_batch("COMMIT")?;
            Ok(())
        });
        if result.is_err() {
            let _ = self.state.execute_batch("ROLLBACK");
            let _ = self.eventlog.execute_batch("ROLLBACK");
        }
        result
    }
}

/// `makeMaterializeEvent`: applies `event` to the state DB and, unless `skip_eventlog`, appends it to the eventlog.
pub fn materialize_event(
    state_conn: &Connection,
    eventlog_conn: &Connection,
    schema: &Schema,
    event: &Event,
    skip_eventlog: bool,
    sync_metadata: Option<&Value>,
) -> Result<()> {
    let schema_hash = state::materialize(state_conn, schema, event)?;
    if !skip_eventlog {
        eventlog::insert(eventlog_conn, event, schema_hash, sync_metadata)?;
    }
    Ok(())
}

/// `isSameSequencePosition`: global and client equal, generation ignored.
pub fn same_position(a: SeqNum, b: SeqNum) -> bool {
    a.global == b.global && a.client == b.client
}

pub fn query_rows(conn: &Connection, sql: &str) -> Result<Vec<Row>> {
    query_rows_with(conn, sql, &[])
}

pub fn query_rows_with(
    conn: &Connection,
    sql: &str,
    binds: &[livestore_schema::SqlValue],
) -> Result<Vec<Row>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let rows = stmt.query_map(
        rusqlite::params_from_iter(binds.iter().map(state::to_sql)),
        |r| {
            let mut row = Map::new();
            for (i, name) in names.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => n.into(),
                    ValueRef::Real(f) => f.into(),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into(),
                    ValueRef::Blob(b) => b.iter().map(|x| Value::from(*x)).collect(),
                };
                row.insert(name.clone(), v);
            }
            Ok(row)
        },
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}
