//! IO-free `LiveStore` primitives: sequence numbers, encoded events and the sync-state merge
//! (`schema/EventSequenceNumber`, `schema/LiveStoreEvent`, `sync/syncstate.ts`).

#![warn(clippy::unwrap_used)]

pub mod event;
pub mod next;
pub mod seqnum;
pub mod syncstate;

pub use event::{Event, GlobalEvent, is_equal_encoded};
pub use seqnum::SeqNum;
pub use syncstate::{MergeContext, MergeError, MergeResult, Payload, SyncState, merge};
