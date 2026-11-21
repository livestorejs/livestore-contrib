//! Single-session leader without a sync processor: numbering + merge + persistence in one call.
//! Used by fixture replays and offline tools; the real leader is `livestore_sync::Leader`.

use std::path::Path;
use std::sync::Arc;

use livestore_core::syncstate::{self, MergeResult, Payload};
use livestore_core::{Event, SyncState, is_equal_encoded};
use livestore_schema::{Schema, Val};
use serde_json::Value;

use crate::db::{LeaderDb, PulledEvent, UpstreamCommit};
use crate::{Error, Result};

pub struct LocalLeader {
    db: LeaderDb,
    sync_state: SyncState,
    client_id: String,
    session_id: String,
}

impl LocalLeader {
    /// # Errors
    ///
    /// Fails as [`LeaderDb::open`] and [`Self::new`].
    pub fn open(
        state: impl AsRef<Path>,
        eventlog: impl AsRef<Path>,
        schema: Arc<Schema>,
        client_id: &str,
        session_id: &str,
    ) -> Result<Self> {
        Self::new(
            LeaderDb::open(state, eventlog, schema)?,
            client_id,
            session_id,
        )
    }

    /// # Errors
    ///
    /// Fails as [`LeaderDb::open_in_memory`] and [`Self::new`].
    pub fn open_in_memory(schema: Arc<Schema>, client_id: &str, session_id: &str) -> Result<Self> {
        Self::new(LeaderDb::open_in_memory(schema)?, client_id, session_id)
    }

    /// # Errors
    ///
    /// Fails as [`LeaderDb::initial_sync_state`].
    pub fn new(db: LeaderDb, client_id: &str, session_id: &str) -> Result<Self> {
        let sync_state = db.initial_sync_state()?;
        Ok(Self {
            db,
            sync_state,
            client_id: client_id.into(),
            session_id: session_id.into(),
        })
    }

    /// Numbers a new local event after the local head, materializes it and appends it to the eventlog.
    ///
    /// # Errors
    ///
    /// Fails with [`Error::Merge`] or [`Error::Invariant`] when the local push does not advance, and as
    /// [`LeaderDb::persist_local`].
    pub fn commit(&mut self, name: &str, args: Value) -> Result<Event> {
        let (seq_num, parent_seq_num) = self
            .sync_state
            .local_head
            .next_pair(self.db.schema().is_client_only(name), None);
        let event = Event {
            name: name.into(),
            args,
            seq_num,
            parent_seq_num,
            client_id: self.client_id.clone(),
            session_id: self.session_id.clone(),
        };
        let merge = self.merge(
            &Payload::LocalPush {
                new_events: vec![event.clone()],
            },
            false,
        )?;
        let MergeResult::Advance {
            new_sync_state,
            new_events,
            ..
        } = merge
        else {
            return Err(Error::Invariant(format!(
                "local push did not advance: {merge:?}"
            )));
        };
        self.db.persist_local(&new_events)?;
        self.sync_state = new_sync_state;
        Ok(event)
    }

    /// `store.commit(event)`: replaces top-level `SessionIdSymbol` args with this session's id on a copy, so the
    /// caller's args stay untouched, then commits.
    ///
    /// # Errors
    ///
    /// Fails as [`Self::commit`].
    pub fn commit_val(&mut self, name: &str, args: &Val) -> Result<Event> {
        let resolved = match args {
            Val::Object(fields) => Val::Object(
                fields
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            if *v == session_id_symbol() {
                                Val::String(self.session_id.clone())
                            } else {
                                v.clone()
                            },
                        )
                    })
                    .collect(),
            ),
            other => other.clone(),
        };
        self.commit(name, resolved.to_json_value())
    }

    /// Merges a backend page (`upstream-advance`, client-only events ignored) and persists the result.
    ///
    /// # Errors
    ///
    /// Fails with [`Error::Merge`] when the merge fails, with [`Error::Invariant`] when the batch is rejected or
    /// empty, and as [`LeaderDb::persist_upstream`].
    pub fn apply_upstream(&mut self, pulled: &[PulledEvent]) -> Result<MergeResult> {
        let new_events = pulled.iter().map(|p| p.event.clone()).collect();
        let merge = self.merge(&Payload::UpstreamAdvance { new_events }, true)?;
        let (new_sync_state, events, rollback_events, confirmed_events) = match &merge {
            MergeResult::Advance {
                new_sync_state,
                new_events,
                confirmed_events,
                ..
            } => (new_sync_state, new_events, &[][..], &confirmed_events[..]),
            MergeResult::Rebase {
                new_sync_state,
                new_events,
                rollback_events,
                ..
            } => (new_sync_state, new_events, &rollback_events[..], &[][..]),
            MergeResult::Reject { .. } => {
                return Err(Error::Invariant("upstream batch rejected".into()));
            }
        };
        let backend_head = pulled
            .last()
            .map(|p| p.event.seq_num)
            .ok_or_else(|| Error::Invariant("upstream batch has no head".into()))?;
        self.db.persist_upstream(&UpstreamCommit {
            pulled_events: pulled,
            events,
            rollback_events,
            confirmed_events,
            backend_head,
        })?;
        self.sync_state = new_sync_state.clone();
        Ok(merge)
    }

    /// # Errors
    ///
    /// Fails as [`LeaderDb::rebuild_state`].
    pub fn rebuild_state(&mut self) -> Result<()> {
        self.db.rebuild_state()
    }

    pub fn sync_state(&self) -> &SyncState {
        &self.sync_state
    }

    pub fn db(&self) -> &LeaderDb {
        &self.db
    }

    pub fn into_db(self) -> LeaderDb {
        self.db
    }

    /// Pending synced events (client-only events never leave).
    pub fn pending_to_push(&self) -> Vec<Event> {
        self.sync_state
            .pending
            .iter()
            .filter(|e| !self.db.schema().is_client_only(&e.name))
            .cloned()
            .collect()
    }

    fn merge(&self, payload: &Payload, ignore_client_only: bool) -> Result<MergeResult> {
        let schema = self.db.schema();
        Ok(syncstate::merge(
            &self.sync_state,
            payload,
            |e| schema.is_client_only(&e.name),
            is_equal_encoded,
            ignore_client_only,
        )?)
    }
}

/// `SessionIdSymbol`: stands for the committing session's id in event args.
#[must_use]
pub fn session_id_symbol() -> Val {
    Val::Symbol("SessionIdSymbol".into())
}
