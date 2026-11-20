//! Tagged errors of `sync/errors.ts`, `errors.ts` and `leader-thread/RejectedPushError.ts`.

use livestore_core::SeqNum;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("IsOfflineError: {cause}")]
pub struct IsOfflineError {
    pub cause: String,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("BackendIdMismatchError: expected {expected}, received {received}")]
pub struct BackendIdMismatchError {
    pub expected: String,
    pub received: String,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("ServerAheadError: minimum expected {minimum_expected_num}, provided {provided_num}")]
pub struct ServerAheadError {
    pub minimum_expected_num: i64,
    pub provided_num: i64,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("UnknownError: {cause}{}", note.as_ref().map(|n| format!(" ({n})")).unwrap_or_default())]
pub struct UnknownError {
    pub cause: String,
    pub note: Option<String>,
}

impl UnknownError {
    pub fn new(cause: impl ToString) -> Self {
        Self {
            cause: cause.to_string(),
            note: None,
        }
    }

    pub fn with_note(cause: impl ToString, note: &str) -> Self {
        Self {
            cause: cause.to_string(),
            note: Some(note.into()),
        }
    }
}

macro_rules! error_union {
    ($(#[$m:meta])* $name:ident { $($variant:ident($ty:ty)),* $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, PartialEq, thiserror::Error)]
        pub enum $name {
            $(#[error(transparent)] $variant(#[from] $ty),)*
        }

        impl $name {
            /// The TS `_tag`.
            pub fn tag(&self) -> &'static str {
                match self { $(Self::$variant(_) => concat!(stringify!($variant), "Error"),)* }
            }
        }
    };
}

error_union!(
    /// `SyncBackend.connect` failure channel.
    ConnectError { IsOffline(IsOfflineError), Unknown(UnknownError) }
);
error_union!(
    /// `SyncBackend.pull` failure channel.
    PullError { IsOffline(IsOfflineError), BackendIdMismatch(BackendIdMismatchError), Unknown(UnknownError) }
);
error_union!(
    /// `SyncBackend.push` failure channel.
    PushError {
        IsOffline(IsOfflineError),
        BackendIdMismatch(BackendIdMismatchError),
        Unknown(UnknownError),
        ServerAhead(ServerAheadError),
    }
);
error_union!(
    /// `SyncBackend.ping` failure channel (`Cause.TimeoutError` = `Timeout`).
    PingError { IsOffline(IsOfflineError), Unknown(UnknownError), Timeout(TimeoutError) }
);

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("TimeoutError")]
pub struct TimeoutError;

/// `RejectedPushError`: the session must rebase and retry.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RejectedPushError {
    #[error(
        "LeaderAheadError: expected > {minimum_expected_num}, got {provided_num} (session {session_id})"
    )]
    LeaderAhead {
        minimum_expected_num: SeqNum,
        provided_num: SeqNum,
        session_id: String,
    },
    #[error(
        "NonContiguousBatchError at index {violation_index}: expected {expected_seq_num} after {expected_parent_seq_num}, got {provided_seq_num} after {provided_parent_seq_num} (session {session_id})"
    )]
    NonContiguousBatch {
        expected_seq_num: SeqNum,
        provided_seq_num: SeqNum,
        expected_parent_seq_num: SeqNum,
        provided_parent_seq_num: SeqNum,
        violation_index: usize,
        session_id: String,
    },
    #[error(
        "NonMonotonicBatchError at index {violation_index}: {preceding_seq_num} >= {violating_seq_num} (session {session_id})"
    )]
    NonMonotonicBatch {
        preceding_seq_num: SeqNum,
        violating_seq_num: SeqNum,
        violation_index: usize,
        session_id: String,
    },
    #[error(
        "StaleRebaseGenerationError: expected >= {current_rebase_generation}, got {provided_rebase_generation} (session {session_id})"
    )]
    StaleRebaseGeneration {
        current_rebase_generation: i64,
        provided_rebase_generation: i64,
        session_id: String,
    },
}

impl RejectedPushError {
    pub fn tag(&self) -> &'static str {
        match self {
            Self::LeaderAhead { .. } => "LeaderAheadError",
            Self::NonContiguousBatch { .. } => "NonContiguousBatchError",
            Self::NonMonotonicBatch { .. } => "NonMonotonicBatchError",
            Self::StaleRebaseGeneration { .. } => "StaleRebaseGenerationError",
        }
    }
}

/// `LeaderSyncProcessor.push` failure: rejected (rebase and retry) or interrupted (leader stopped).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LeaderPushError {
    #[error(transparent)]
    Rejected(#[from] RejectedPushError),
    #[error("push interrupted: leader stopped")]
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentionalShutdownReason {
    DevtoolsReset,
    DevtoolsImport,
    AdapterReset,
    Manual,
    BackendIdMismatch,
}

/// `ShutdownChannel.All`: why the leader stopped.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ShutdownCause {
    #[error("IntentionalShutdownCause: {0:?}")]
    IntentionalShutdownCause(IntentionalShutdownReason),
    #[error(transparent)]
    UnknownError(UnknownError),
    #[error(transparent)]
    BackendIdMismatchError(BackendIdMismatchError),
    #[error("MaterializeError: {0}")]
    MaterializeError(String),
    #[error("MaterializationJournalError: {0}")]
    MaterializationJournalError(String),
}

impl ShutdownCause {
    pub fn tag(&self) -> &'static str {
        match self {
            Self::IntentionalShutdownCause(_) => "IntentionalShutdownCause",
            Self::UnknownError(_) => "UnknownError",
            Self::BackendIdMismatchError(_) => "BackendIdMismatchError",
            Self::MaterializeError(_) => "MaterializeError",
            Self::MaterializationJournalError(_) => "MaterializationJournalError",
        }
    }

    /// `Schema.is(Shutdown.All)(error) ? error : UnknownError.make({ cause, note })`.
    pub(crate) fn from_storage(e: &livestore_sqlite::Error) -> Self {
        match e {
            livestore_sqlite::Error::Materialize(m) => Self::MaterializeError(m.to_string()),
            livestore_sqlite::Error::UnknownEvent(u) => Self::MaterializeError(u.to_string()),
            livestore_sqlite::Error::MaterializationJournal(m) => {
                Self::MaterializationJournalError(m.clone())
            }
            other => Self::UnknownError(UnknownError::with_note(other, "Leader sync loop failed")),
        }
    }
}
