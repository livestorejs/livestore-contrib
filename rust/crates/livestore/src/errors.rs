//! Store-side errors (`MaterializeError`, `MaterializationJournalError`, `UnknownError`) and defects.

use std::fmt;
use std::sync::Arc;

/// An Effect defect (`Effect.die`): an unexpected failure. Cloning keeps the same instance, so tests can
/// check identity like TS `toBe`.
#[derive(Clone)]
pub struct Defect(Arc<dyn std::error::Error + Send + Sync>);

impl Defect {
    pub fn new(error: impl std::error::Error + Send + Sync + 'static) -> Self {
        Defect(Arc::new(error))
    }

    pub fn msg(message: impl Into<String>) -> Self {
        Defect(Arc::new(Message(message.into())))
    }

    pub fn message(&self) -> String {
        self.0.to_string()
    }

    pub fn ptr_eq(&self, other: &Defect) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for Defect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Defect({})", self.0)
    }
}

impl fmt::Display for Defect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl PartialEq for Defect {
    fn eq(&self, other: &Self) -> bool {
        self.ptr_eq(other)
    }
}

/// `MaterializeError.cause`.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum MaterializeCause {
    #[error("MaterializerHashMismatchError: {event_name}")]
    MaterializerHashMismatch { event_name: String },
    #[error("{0}")]
    Other(String),
}

/// Failure channel of the session processor and of a Store shutdown (`Exit` failure).
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum StoreError {
    #[error("MaterializeError: {0}")]
    Materialize(MaterializeCause),
    #[error("MaterializationJournalError: {0}")]
    MaterializationJournal(String),
    #[error("UnknownError: {0}")]
    Unknown(String),
    #[error("{0}")]
    Defect(Defect),
}

impl StoreError {
    pub fn tag(&self) -> &'static str {
        match self {
            StoreError::Materialize(_) => "MaterializeError",
            StoreError::MaterializationJournal(_) => "MaterializationJournalError",
            StoreError::Unknown(_) => "UnknownError",
            StoreError::Defect(_) => "Defect",
        }
    }

    pub fn defect(message: impl Into<String>) -> Self {
        StoreError::Defect(Defect::msg(message))
    }

    /// `Cause.squash`: the defect itself, or the error.
    pub fn as_defect(&self) -> Option<&Defect> {
        match self {
            StoreError::Defect(d) => Some(d),
            _ => None,
        }
    }

    pub(crate) fn from_sqlite(e: livestore_sqlite::Error) -> Self {
        match e {
            livestore_sqlite::Error::Materialize(m) => {
                StoreError::Materialize(MaterializeCause::Other(m.to_string()))
            }
            livestore_sqlite::Error::UnknownEvent(u) => {
                StoreError::Materialize(MaterializeCause::Other(u.to_string()))
            }
            livestore_sqlite::Error::MaterializationJournal(m) => {
                StoreError::MaterializationJournal(m)
            }
            other => StoreError::Unknown(other.to_string()),
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Unknown(format!("SqliteError: {e}"))
    }
}

/// `Exit<void, StoreError>`.
pub type Exit = Result<(), StoreError>;

#[derive(Debug)]
struct Message(String);

impl fmt::Display for Message {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Message {}
