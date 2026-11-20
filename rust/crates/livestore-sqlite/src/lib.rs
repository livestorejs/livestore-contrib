//! Leader storage: eventlog DB, state DB (materialization, journal, rollback, rebuild) and
//! `LeaderPersistence` (`packages/@livestore/common/src/leader-thread/*`).

pub mod db;
pub mod eventlog;
pub mod helper;
pub mod local;
pub mod state;

pub use db::{BootOptions, LeaderDb, PulledEvent, Receipt, Row, UpstreamCommit, materialize_event};
pub use eventlog::{EventQuery, PullCursorInfo};
pub use local::{LocalLeader, session_id_symbol};

use livestore_core::MergeError;
use livestore_schema::{MaterializeError, UnknownEventError};

/// Storage errors, named after the TS tagged errors they mirror.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("SqliteError: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("SqliteError: {cause} ({sql})")]
    SqliteQuery { sql: String, cause: rusqlite::Error },
    #[error("UnknownError: {0}")]
    Unknown(String),
    #[error("MaterializeError: {0}")]
    Materialize(#[from] MaterializeError),
    #[error("UnknownEventError: {0}")]
    UnknownEvent(#[from] UnknownEventError),
    #[error("MaterializationJournalError: {0}")]
    MaterializationJournal(String),
    #[error("merge failed: {0}")]
    Merge(#[from] MergeError),
    #[error("{0}")]
    Invariant(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
