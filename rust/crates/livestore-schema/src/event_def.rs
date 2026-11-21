//! `Events.synced` / `Events.clientOnly` (`schema/EventDef`) and materializers.

use std::collections::HashSet;
use std::marker::PhantomData;
use std::sync::Arc;

use livestore_core::Event as LogEvent;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

use crate::codec::{date_from_iso_string, iso_string_from_js_date};
use crate::fingerprint::schema_hash;
use crate::value::{SqlStatement, SqlValue};
use crate::value_schema::{self as s, ValueSchema};

/// An event, defined by its args type. Derive it with `#[derive(Event)]`.
pub trait Event: Serialize + DeserializeOwned + Sized + 'static {
    const NAME: &'static str;

    /// The event definition: name, args schema and options.
    fn def() -> &'static EventDef<Self>;
}

/// An event to commit: its name and encoded args (`LiveStoreEvent.Input`).
///
/// Only a derived [`Event`] or a client document's `set` builds one, so a commit can never name
/// an unknown event or pass args of the wrong shape. Tests that port core's untyped cases use
/// `EventInput::raw`, behind the `testing` feature.
#[derive(Clone, Debug, PartialEq)]
pub struct EventInput {
    name: String,
    args: Value,
}

impl EventInput {
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn args(&self) -> &Value {
        &self.args
    }

    #[must_use]
    pub fn into_parts(self) -> (String, Value) {
        (self.name, self.args)
    }

    /// An event from a name and JSON args, without type checks. Only for tests.
    #[cfg(feature = "testing")]
    #[must_use]
    pub fn raw(name: impl Into<String>, args: Value) -> Self {
        Self {
            name: name.into(),
            args,
        }
    }

    pub(crate) fn new(name: String, args: Value) -> Self {
        Self { name, args }
    }
}

/// # Panics
///
/// Panics when the args do not serialize, for example a `DateFromString` holding an invalid date.
impl<E: Event> From<E> for EventInput {
    fn from(event: E) -> Self {
        let (name, args) = E::def().make(event);
        Self { name, args }
    }
}

#[cfg(feature = "testing")]
impl From<(String, Value)> for EventInput {
    fn from((name, args): (String, Value)) -> Self {
        Self { name, args }
    }
}

#[cfg(feature = "testing")]
impl From<&LogEvent> for EventInput {
    fn from(e: &LogEvent) -> Self {
        Self {
            name: e.name.clone(),
            args: e.args.clone(),
        }
    }
}

/// What a commit accepts: one event, a tuple of events (a batch of mixed types), or a list.
///
/// Each item is checked on its own, so a batch can mix event types and still cannot hold an
/// unknown event or raw JSON.
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not a LiveStore event",
    label = "expected a `#[derive(Event)]` struct, a tuple or a list of them",
    note = "define the event as a struct with `#[derive(Event)]` and commit a value of it; a commit never takes a name or JSON"
)]
pub trait Events {
    /// Appends the events in order.
    fn push_into(self, out: &mut Vec<EventInput>);

    /// The events in order.
    fn into_inputs(self) -> Vec<EventInput>
    where
        Self: Sized,
    {
        let mut out = Vec::new();
        self.push_into(&mut out);
        out
    }
}

impl<E: Event> Events for E {
    fn push_into(self, out: &mut Vec<EventInput>) {
        out.push(self.into());
    }
}

impl Events for EventInput {
    fn push_into(self, out: &mut Vec<EventInput>) {
        out.push(self);
    }
}

impl<T: Events> Events for Vec<T> {
    fn push_into(self, out: &mut Vec<EventInput>) {
        for events in self {
            events.push_into(out);
        }
    }
}

impl<T: Events, const N: usize> Events for [T; N] {
    fn push_into(self, out: &mut Vec<EventInput>) {
        for events in self {
            events.push_into(out);
        }
    }
}

#[cfg(feature = "testing")]
impl Events for (String, Value) {
    fn push_into(self, out: &mut Vec<EventInput>) {
        out.push(self.into());
    }
}

macro_rules! tuple_events {
    ($($name:ident),+) => {
        impl<$($name: Events),+> Events for ($($name,)+) {
            #[expect(non_snake_case, reason = "the tuple's type names bind its items")]
            fn push_into(self, out: &mut Vec<EventInput>) {
                let ($($name,)+) = self;
                $($name.push_into(out);)+
            }
        }
    };
}

tuple_events!(A, B);
tuple_events!(A, B, C);
tuple_events!(A, B, C, D);
tuple_events!(A, B, C, D, E);
tuple_events!(A, B, C, D, E, F);
tuple_events!(A, B, C, D, E, F, G);
tuple_events!(A, B, C, D, E, F, G, H);
tuple_events!(A, B, C, D, E, F, G, H, I);
tuple_events!(A, B, C, D, E, F, G, H, I, J);
tuple_events!(A, B, C, D, E, F, G, H, I, J, K);
tuple_events!(A, B, C, D, E, F, G, H, I, J, K, L);

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
    ///
    /// # Errors
    ///
    /// Fails when the args do not serialize, for example a `DateFromString` holding an invalid date.
    pub fn encode_json(&self, args: &A) -> Result<String, MaterializeError> {
        serde_json::to_string(args).map_err(|e| MaterializeError::InvalidArgs {
            event: self.name.clone(),
            message: e.to_string(),
        })
    }

    /// `Schema.decodeSync(Schema.fromJsonString(event.schema))`.
    ///
    /// # Errors
    ///
    /// Fails when `json` is not valid JSON or does not match the args type.
    pub fn decode_json(&self, json: &str) -> Result<A, MaterializeError> {
        serde_json::from_str(json).map_err(|e| MaterializeError::InvalidArgs {
            event: self.name.clone(),
            message: e.to_string(),
        })
    }

    /// `eventDef(args)`: name plus encoded args, ready to commit.
    ///
    /// # Panics
    ///
    /// Panics when the args do not serialize, for example a `DateFromString` holding an invalid date.
    pub fn make(&self, args: A) -> (String, Value) {
        (
            self.name.clone(),
            serde_json::to_value(args).expect("event args serialize"),
        )
    }

    /// The eventlog stores missing args as `{}` (core: `args ?? {}`), so `{}` also decodes as if it
    /// were `null`. Core's `Schema.Void` accepts `{}` the same way.
    ///
    /// # Errors
    ///
    /// Fails when `args` does not match the args type.
    pub fn decode(&self, args: &Value) -> Result<A, MaterializeError> {
        serde_json::from_value(args.clone())
            .or_else(|e| match args.as_object() {
                Some(map) if map.is_empty() => serde_json::from_value(Value::Null).map_err(|_| e),
                _ => Err(e),
            })
            .map_err(|e| MaterializeError::InvalidArgs {
                event: self.name.clone(),
                message: e.to_string(),
            })
    }
}

/// What a materializer sees besides its args (TS `{ event, query, currentFacts }`; no facts yet).
pub struct MaterializeContext<'a> {
    pub event: &'a LogEvent,
    /// Reads the state DB inside the materialization (`ctx.query`); `None` where no DB is at hand.
    pub query: Option<&'a QueryFn<'a>>,
}

/// `ctx.query({ query, bindValues })`: rows as JSON objects.
pub type QueryFn<'a> = dyn Fn(&str, &[SqlValue]) -> Result<Vec<Value>, MaterializeError> + 'a;

impl<'a> MaterializeContext<'a> {
    #[must_use]
    pub fn new(event: &'a LogEvent) -> Self {
        Self { event, query: None }
    }

    /// # Errors
    ///
    /// Fails when no query function is set on the context, or with the error the query returns.
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
        serializer.serialize_str(&iso_string_from_js_date(self.0))
    }
}

impl<'de> Deserialize<'de> for DateFromString {
    #[expect(
        clippy::cast_precision_loss,
        reason = "epoch millis become a JS Date number"
    )]
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        date_from_iso_string(&s)
            .map(|ms| DateFromString(ms as f64))
            .ok_or_else(|| serde::de::Error::custom(format!("Invalid Date: {s}")))
    }
}
