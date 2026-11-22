//! Leader storage: eventlog DB, state DB (materialization, journal, rollback, rebuild) and
//! `LeaderPersistence` (`packages/@livestore/common/src/leader-thread/*`).

#![warn(clippy::unwrap_used)]

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
use rusqlite::Connection;
use rusqlite::config::DbConfig;

/// Runtime settings that make rusqlite's bundled SQLite behave like core's wa-sqlite build
/// (`SQLITE_DQS=0`, no `SQLITE_DEFAULT_FOREIGN_KEYS`). Applied to every connection `LiveStore` opens.
///
/// # Errors
///
/// Fails when SQLite rejects a `DbConfig` setting.
pub fn configure_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, false)?;
    Ok(())
}

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
    #[error("data folder in use: another leader holds {}", .0.display())]
    Locked(std::path::PathBuf),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
