//! `makeSchema` (`schema/schema.ts`) and unknown event handling (`schema/unknown-events.ts`).

use std::collections::HashMap;
use std::sync::Arc;

use livestore_core::Event;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::client_document::ClientDocument;
use crate::event_def::{
    EventDef, IntoStatements, MaterializeContext, MaterializeError, Materializer,
};
use crate::fingerprint::schema_hash;
use crate::table::Table;

/// Runtime view of one event definition.
#[derive(Clone)]
pub struct EventInfo {
    pub name: String,
    pub client_only: bool,
    pub materializer: Option<Materializer>,
    /// `Schema.hash(eventDef.schema)`, stored as the eventlog's and event-defs table's `schemaHash`.
    pub schema_hash: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownEventReason {
    EventDefinitionMissing,
    MaterializerMissing,
}

#[derive(Clone, Debug)]
pub struct UnknownEventContext {
    pub event_name: String,
    pub reason: UnknownEventReason,
    pub operation: String,
}

/// `UnknownEvents.HandlingConfig`; default `Warn`.
#[derive(Clone, Default)]
pub enum UnknownEventHandling {
    #[default]
    Warn,
    Ignore,
    Fail,
    Callback(Arc<dyn Fn(&UnknownEventContext) + Send + Sync>),
}

/// `UnknownEventError`.
#[derive(Debug, Clone, thiserror::Error)]
#[error("unknown event {} ({:?}) during {}", .0.event_name, .0.reason, .0.operation)]
pub struct UnknownEventError(pub UnknownEventContext);

pub struct Schema {
    tables: Vec<Table>,
    client_documents: Vec<ClientDocument>,
    events: Vec<EventInfo>,
    by_name: HashMap<String, usize>,
    pub unknown_event_handling: UnknownEventHandling,
}

impl Schema {
    #[must_use]
    pub fn builder() -> SchemaBuilder {
        SchemaBuilder::default()
    }

    /// App tables in definition order (client document tables included).
    #[must_use]
    pub fn tables(&self) -> &[Table] {
        &self.tables
    }

    #[must_use]
    pub fn client_documents(&self) -> &[ClientDocument] {
        &self.client_documents
    }

    #[must_use]
    pub fn events(&self) -> &[EventInfo] {
        &self.events
    }

    #[must_use]
    pub fn event(&self, name: &str) -> Option<&EventInfo> {
        self.by_name.get(name).map(|i| &self.events[*i])
    }

    /// `eventsDefsMap.get(name)?.options.clientOnly ?? false`.
    #[must_use]
    pub fn is_client_only(&self, name: &str) -> bool {
        self.event(name).is_some_and(|e| e.client_only)
    }

    /// `resolveEventDef`: `Ok(Some(_))` for a known event, `Ok(None)` to skip (warn/ignore/callback), `Err` for `Fail`.
    ///
    /// # Errors
    ///
    /// Fails with [`UnknownEventError`] when the event or its materializer is missing and unknown
    /// events are set to fail.
    pub fn resolve(
        &self,
        event: &Event,
        operation: &str,
    ) -> Result<Option<&Materializer>, UnknownEventError> {
        let reason = match self.event(&event.name) {
            Some(EventInfo {
                materializer: Some(m),
                ..
            }) => return Ok(Some(m)),
            Some(_) => UnknownEventReason::MaterializerMissing,
            None => UnknownEventReason::EventDefinitionMissing,
        };
        let context = UnknownEventContext {
            event_name: event.name.clone(),
            reason,
            operation: operation.into(),
        };
        match &self.unknown_event_handling {
            UnknownEventHandling::Fail => return Err(UnknownEventError(context)),
            UnknownEventHandling::Warn => {
                tracing::warn!(event = %event.name, ?reason, operation, "@livestore/common:schema:unknown-event");
            }
            UnknownEventHandling::Ignore => {}
            UnknownEventHandling::Callback(f) => f(&context),
        }
        Ok(None)
    }
}

#[derive(Default)]
pub struct SchemaBuilder {
    tables: Vec<Table>,
    client_documents: Vec<ClientDocument>,
    events: Vec<EventInfo>,
    unknown_event_handling: UnknownEventHandling,
}

impl SchemaBuilder {
    #[must_use]
    pub fn table(mut self, table: Table) -> Self {
        self.tables.push(table);
        self
    }

    /// Adds the document table and its derived `<name>Set` event with materializer.
    #[must_use]
    pub fn client_document(mut self, doc: ClientDocument) -> Self {
        self.tables.push(doc.table());
        let schema_hash = schema_hash(&doc.set_event_schema());
        self.events.push(EventInfo {
            name: doc.set_event_name(),
            client_only: true,
            materializer: Some(doc.set_materializer()),
            schema_hash,
        });
        self.client_documents.push(doc);
        self
    }

    /// Registers an event with a typed materializer (`State.SQLite.materializers`).
    #[must_use]
    pub fn event<A, R>(
        mut self,
        def: &EventDef<A>,
        materialize: impl Fn(A, &MaterializeContext<'_>) -> Result<R, MaterializeError>
        + Send
        + Sync
        + 'static,
    ) -> Self
    where
        A: Serialize + DeserializeOwned + 'static,
        R: IntoStatements,
    {
        let typed = def.clone();
        let materializer: Materializer =
            Arc::new(move |args, ctx| Ok(materialize(typed.decode(args)?, ctx)?.into_statements()));
        self.events.push(EventInfo {
            name: def.name.clone(),
            client_only: def.client_only,
            materializer: Some(materializer),
            schema_hash: def.schema_hash(),
        });
        self
    }

    /// An event without materializer (resolves as `MaterializerMissing`).
    #[must_use]
    pub fn event_without_materializer<A: Serialize + DeserializeOwned>(
        mut self,
        def: &EventDef<A>,
    ) -> Self {
        self.events.push(EventInfo {
            name: def.name.clone(),
            client_only: def.client_only,
            materializer: None,
            schema_hash: def.schema_hash(),
        });
        self
    }

    #[must_use]
    pub fn unknown_event_handling(mut self, handling: UnknownEventHandling) -> Self {
        self.unknown_event_handling = handling;
        self
    }

    #[must_use]
    pub fn build(self) -> Arc<Schema> {
        let by_name = self
            .events
            .iter()
            .enumerate()
            .map(|(i, e)| (e.name.clone(), i))
            .collect();
        Arc::new(Schema {
            tables: self.tables,
            client_documents: self.client_documents,
            events: self.events,
            by_name,
            unknown_event_handling: self.unknown_event_handling,
        })
    }
}
