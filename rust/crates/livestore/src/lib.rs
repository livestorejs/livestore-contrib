//! Store layer (`packages/@livestore/livestore` and `ClientSessionSyncProcessor`): the reactive graph,
//! live queries, the session sync processor over a leader proxy, the [`Store`] and the [`StoreRegistry`].

// Errors carry full TS fields (sequence numbers, session ids); boxing them would only hurt matching.
#![allow(clippy::result_large_err)]

pub mod adapter;
pub mod errors;
pub mod live_queries;
pub mod processor;
pub mod reactive;
pub mod registry;
pub mod session;
pub mod sqlite;
pub mod store;

pub use adapter::{InMemoryAdapter, make_in_memory_adapter};
pub use errors::{Defect, Exit, MaterializeCause, StoreError};
pub use live_queries::{
    ComputedDef, DbQueryDef, LiveQuery, QueryGet, QueryInput, Queryable, SignalDef,
    client_document_get, computed, query_db, query_db_fn, signal,
};
pub use processor::{ClientSessionSyncProcessor, EventInput, PULL_CHUNK_SIZE, SESSION_ID_SYMBOL};
pub use registry::{RegistryDefaults, RegistryStoreOptions, StoreOrLoading, StoreRegistry};
pub use session::{ClientSession, LeaderPushFailure, LeaderThreadProxy, PullItem};
pub use store::{
    Adapter, AdapterArgs, CommitOptions, EventsOptions, ShutdownDeferred, Store, StoreOptions,
    StoreParams, SubscribeOptions, Subscription, await_shutdown, create_store,
    make_shutdown_deferred,
};
