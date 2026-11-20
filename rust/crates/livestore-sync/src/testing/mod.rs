//! Test doubles (`sync/mock-sync-backend.ts`, `testing/event-factory.ts`).

mod event_factory;
mod mock_backend;

pub use event_factory::{ClientIdentity, EventFactory, Sequence};
pub use mock_backend::{MockSyncBackend, MockSyncBackendOptions, PullFailure, PushFailure};
