//! Leader sync machinery: the `SyncBackend` service, the `LeaderSyncProcessor` actor, the leader
//! builder (`makeLeaderThreadLayer`) and `streamEventsWithSyncState`. With the `testing` feature it
//! also provides `MockSyncBackend` and `EventFactory`.

#![warn(clippy::unwrap_used)]
// Errors carry full TS fields (sequence numbers, session ids); boxing them would only hurt matching.
#![allow(clippy::result_large_err)]

pub mod backend;
pub mod errors;
pub mod leader;
pub mod options;
mod processor;
pub mod pull_queue;
pub mod stream_events;
#[cfg(feature = "testing")]
pub mod testing;

pub use backend::{
    BackendIdStore, BackendMetadata, BackendOverride, MakeBackendArgs, NetworkStatus, PageInfo,
    PullCursor, PullItem, PullOptions, PullResItem, PullStream, Supports, SyncBackend,
    SyncBackendConstructor, constructor, network_status,
};
pub use errors::*;
pub use leader::{BootStatus, Leader, LeaderBuilder, Storage};
pub use options::{
    Backoff, FixedRandom, InitialSyncOptions, OnBackendIdMismatch, OnSyncError, Params, Random,
    ReconnectWait, StdRandom, SyncOptions, Testing, hook,
};
pub use pull_queue::{MaterializerHash, PullQueue, SessionPullItem};
