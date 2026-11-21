//! `Events.synced` / `Events.clientOnly` (`schema/EventDef`) and materializers.

use std::collections::HashSet;
use std::marker::PhantomData;
use std::sync::Arc;

use livestore_core::Event;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

use crate::codec::{date_from_iso_string, iso_string_from_millis};
use crate::fingerprint::schema_hash;
use crate::value::{SqlStatement, SqlValue};
use crate::value_schema::{self as s, ValueSchema};

/// Typed event definition. `A` is the args type; its serde form is the encoded args JSON.
pub struct EventDef<A> {
    pub name: String,
    pub client_only: bool,
    /// `options.deprecated`: reason the whole event is deprecated.
    pub deprecated: Option<String>,
    /// Args fields annotated with `deprecated(reason)`, as `(field, reason)`.
    pub deprecated_fields: Vec<(String, String)>,
    /// The Effect args schema; only its hash is used (`serde` does the coding).
    pub schema: Option<ValueSchema>,
    _args: PhantomData<fn() -> A>,
}

impl<A> Clone for EventDef<A> {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            client_only: self.client_only,
            deprecated: self.deprecated.clone(),
            deprecated_fields: self.deprecated_fields.clone(),
            schema: self.schema.clone(),
            _args: PhantomData,
        }
    }
}

impl<A: Serialize + DeserializeOwned> EventDef<A> {
    #[must_use]
    pub fn synced(name: &str) -> Self {
        Self {
            name: name.into(),
            client_only: false,
            deprecated: None,
            deprecated_fields: vec![],
            schema: None,
            _args: PhantomData,
        }
    }

    #[must_use]
    pub fn client_only(name: &str) -> Self {
        Self {
            client_only: true,
            ..Self::synced(name)
        }
    }

    #[must_use]
    pub fn schema(mut self, schema: ValueSchema) -> Self {
        self.schema = Some(schema);
        self
    }

    /// `Schema.hash(eventDef.schema)`; without an args schema, that of `Schema.Any`.
    #[must_use]
    pub fn schema_hash(&self) -> i32 {
        schema_hash(self.schema.as_ref().unwrap_or(&s::any()))
    }

    #[must_use]
    pub fn deprecated(mut self, reason: &str) -> Self {
        self.deprecated = Some(reason.into());
        self
    }

    /// `deprecated(reason)` on one args field.
    #[must_use]
    pub fn deprecated_field(mut self, field: &str, reason: &str) -> Self {
        self.deprecated_fields.push((field.into(), reason.into()));
        self
    }

    /// `getDeprecatedReason` for an args field.
    #[must_use]
    pub fn field_deprecation(&self, field: &str) -> Option<&str> {
        self.deprecated_fields
            .iter()
            .find(|(f, _)| f == field)
            .map(|(_, r)| r.as_str())
    }

    /// `findDeprecatedFieldsWithValues`: deprecated fields present in the encoded args.
    #[must_use]
    pub fn find_deprecated_fields_with_values(&self, args: &Value) -> Vec<(String, String)> {
        self.deprecated_fields
            .iter()
            .filter(|(f, _)| args.get(f).is_some())
            .cloned()
            .collect()
    }

    /// `Schema.encodeSync(Schema.fromJsonString(event.schema))`.
    pub fn encode_json(&self, args: &A) -> Result<String, MaterializeError> {
        serde_json::to_string(args).map_err(|e| MaterializeError::InvalidArgs {
            event: self.name.clone(),
            message: e.to_string(),
        })
    }

    /// `Schema.decodeSync(Schema.fromJsonString(event.schema))`.
    pub fn decode_json(&self, json: &str) -> Result<A, MaterializeError> {
        serde_json::from_str(json).map_err(|e| MaterializeError::InvalidArgs {
            event: self.name.clone(),
            message: e.to_string(),
        })
    }

    /// `eventDef(args)`: name plus encoded args, ready to commit.
    pub fn make(&self, args: A) -> (String, Value) {
        (
            self.name.clone(),
            serde_json::to_value(args).expect("event args serialize"),
        )
    }

    pub fn decode(&self, args: &Value) -> Result<A, MaterializeError> {
        serde_json::from_value(args.clone()).map_err(|e| MaterializeError::InvalidArgs {
            event: self.name.clone(),
            message: e.to_string(),
        })
    }
}

/// What a materializer sees besides its args (TS `{ event, query, currentFacts }`; no facts yet).
pub struct MaterializeContext<'a> {
    pub event: &'a Event,
    /// Reads the state DB inside the materialization (`ctx.query`); `None` where no DB is at hand.
    pub query: Option<&'a QueryFn<'a>>,
}

/// `ctx.query({ query, bindValues })`: rows as JSON objects.
pub type QueryFn<'a> = dyn Fn(&str, &[SqlValue]) -> Result<Vec<Value>, MaterializeError> + 'a;

impl<'a> MaterializeContext<'a> {
    #[must_use]
    pub fn new(event: &'a Event) -> Self {
        Self { event, query: None }
    }

    pub fn query(&self, sql: &str, binds: &[SqlValue]) -> Result<Vec<Value>, MaterializeError> {
        let query = self
            .query
            .ok_or_else(|| MaterializeError::Other("ctx.query is not available here".into()))?;
        query(sql, binds)
    }
}

/// Type-erased materializer over encoded args.
pub type Materializer = Arc<
    dyn Fn(&Value, &MaterializeContext<'_>) -> Result<Vec<SqlStatement>, MaterializeError>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum MaterializeError {
    #[error("invalid args for {event}: {message}")]
    InvalidArgs { event: String, message: String },
    #[error("{0}")]
    Other(String),
}

/// Lets materializers return one statement, several, or none.
pub trait IntoStatements {
    fn into_statements(self) -> Vec<SqlStatement>;
}

impl IntoStatements for SqlStatement {
    fn into_statements(self) -> Vec<SqlStatement> {
        vec![self]
    }
}

impl IntoStatements for Vec<SqlStatement> {
    fn into_statements(self) -> Vec<SqlStatement> {
        self
    }
}

impl IntoStatements for () {
    fn into_statements(self) -> Vec<SqlStatement> {
        vec![]
    }
}

/// Deduplicates deprecation warnings (`logDeprecationWarnings`); TS keeps this state module-global.
#[derive(Default, Debug)]
pub struct DeprecationWarnings {
    events: HashSet<String>,
    fields: HashSet<String>,
}

impl DeprecationWarnings {
    /// Logs each event/field deprecation once and returns the `(message, details)` pairs it logged.
    pub fn log<A: Serialize + DeserializeOwned>(
        &mut self,
        def: &EventDef<A>,
        args: &Value,
    ) -> Vec<(&'static str, Value)> {
        let mut logged = vec![];
        if let Some(reason) = &def.deprecated
            && self.events.insert(def.name.clone())
        {
            logged.push((
                "@livestore/schema:deprecated-event",
                json!({ "event": def.name, "reason": reason }),
            ));
        }
        for (field, reason) in def.find_deprecated_fields_with_values(args) {
            if self.fields.insert(format!("{}:{field}", def.name)) {
                logged.push((
                    "@livestore/schema:deprecated-field",
                    json!({ "event": def.name, "field": field, "reason": reason }),
                ));
            }
        }
        for (message, details) in &logged {
            tracing::warn!(%details, "{message}");
        }
        logged
    }

    /// `resetDeprecationWarnings`.
    pub fn reset(&mut self) {
        self.events.clear();
        self.fields.clear();
    }
}

/// `Schema.DateFromString`: a `Date` (epoch millis, possibly NaN) encoded as an ISO string.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DateFromString(pub f64);

impl Serialize for DateFromString {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if !self.0.is_finite() {
            return Err(serde::ser::Error::custom("Invalid Date"));
        }
        serializer.serialize_str(&iso_string_from_millis(self.0 as i64))
    }
}

impl<'de> Deserialize<'de> for DateFromString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        date_from_iso_string(&s)
            .map(|ms| DateFromString(ms as f64))
            .ok_or_else(|| serde::de::Error::custom(format!("Invalid Date: {s}")))
    }
}
