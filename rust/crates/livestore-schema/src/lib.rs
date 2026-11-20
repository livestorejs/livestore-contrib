//! Schema DSL (`packages/@livestore/common/src/schema/**`): tables and DDL, client documents,
//! event definitions, materializers and `makeSchema`. Materializers return SQL statements (like TS
//! query builders), so this crate stays IO-free; `livestore-sqlite` executes them.

pub mod client_document;
pub mod codec;
pub mod column;
pub mod event_def;
pub mod fingerprint;
pub mod migration;
pub mod query_builder;
pub mod representation;
pub mod schema;
pub mod system_tables;
pub mod table;
pub mod value;
pub mod value_schema;

pub use client_document::ClientDocument;
pub use event_def::{EventDef, IntoStatements, MaterializeContext, MaterializeError, Materializer};
pub use schema::{
    EventInfo, Schema, SchemaBuilder, UnknownEventContext, UnknownEventError, UnknownEventHandling,
    UnknownEventReason,
};
pub use table::{Column, ColumnDefault, ColumnType, DefaultValue, Index, Table};
pub use value::{SqlStatement, SqlValue};
pub use value_schema::{Val, ValueSchema};
