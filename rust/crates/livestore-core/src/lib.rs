//! IO-free LiveStore primitives: sequence numbers and encoded events
//! (`schema/EventSequenceNumber`, `schema/LiveStoreEvent`).

#![warn(clippy::unwrap_used)]

pub mod event;
pub mod seqnum;

pub use event::{Event, GlobalEvent, is_equal_encoded};
pub use seqnum::SeqNum;
