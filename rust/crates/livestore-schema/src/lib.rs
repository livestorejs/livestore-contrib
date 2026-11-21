//! Schema DSL (`packages/@livestore/common/src/schema/**`): tables and DDL, client documents,
//! event definitions, materializers and `makeSchema`. Materializers return SQL statements (like TS
//! query builders), so this crate stays IO-free; `livestore-sqlite` executes them.

#![warn(clippy::unwrap_used)]

pub mod client_document;
pub mod codec;
pub mod column;
pub mod event_def;
pub mod fingerprint;
pub mod migration;
pub mod query_builder;
pub mod schema;
pub mod schema_type;
pub mod system_tables;
pub mod table;
pub mod value;
pub mod value_schema;

pub use client_document::ClientDocument;
pub use event_def::{
    Event, EventDef, EventInput, IntoStatements, MaterializeContext, MaterializeError, Materializer,
};
pub use livestore_macros::Event;
pub use schema::{
    EventInfo, Schema, SchemaBuilder, UnknownEventContext, UnknownEventError, UnknownEventHandling,
    UnknownEventReason,
};
pub use schema_type::SchemaType;
pub use table::{Column, ColumnDefault, ColumnType, DefaultValue, Index, Table};
pub use value::{SqlStatement, SqlValue};
pub use value_schema::{Val, ValueSchema};
