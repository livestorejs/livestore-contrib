//! `State.SQLite.clientDocument` (`schema/state/sqlite/client-document-def.ts`): an `(id, value JSON)` table
//! plus its derived client-only `<name>Set` event, which merges a (partial) value into the row.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::column::Column;
use crate::event_def::{EventInput, MaterializeError, Materializer};
use crate::table::Table;
use crate::value::{SqlStatement, SqlValue};
use crate::value_schema::{self as s, SchemaError, Val, ValueSchema};

#[derive(Clone, Debug)]
pub struct ClientDocument {
    pub name: String,
    pub value_schema: ValueSchema,
    /// `default.id`; `None` means callers must pass an id (or the session id).
    pub default_id: Option<String>,
    pub default_value: Val,
    /// `partialSet` option (default `true`); only effective for struct value schemas.
    pub partial_set: bool,
}

impl ClientDocument {
    pub fn new(name: &str, value_schema: ValueSchema, default_value: impl Into<Val>) -> Self {
        Self {
            name: name.into(),
            value_schema,
            default_id: None,
            default_value: default_value.into(),
            partial_set: true,
        }
    }

    #[must_use]
    pub fn default_id(mut self, id: &str) -> Self {
        self.default_id = Some(id.into());
        self
    }

    #[must_use]
    pub fn partial_set(mut self, partial_set: bool) -> Self {
        self.partial_set = partial_set;
        self
    }

    fn can_partial_set(&self) -> bool {
        self.partial_set && !self.value_schema.fields().is_empty()
    }

    /// The `(id, value)` table; the value column always decodes full documents optimistically.
    #[must_use]
    pub fn table(&self) -> Table {
        let value = create_optimistic_event_schema(&self.value_schema, &self.default_value, false);
        let mut table = Table::new(&self.name)
            .column(Column::text("id").primary_key())
            .column(Column::json("value").schema(value));
        table.is_client_document_table = true;
        table
    }

    #[must_use]
    pub fn row_schema(&self) -> ValueSchema {
        self.table().row_schema()
    }

    #[must_use]
    pub fn set_event_name(&self) -> String {
        format!("{}Set", self.name)
    }

    /// Args schema of the `<name>Set` event as registered in the schema (what `Schema.hash` covers).
    #[must_use]
    pub fn set_event_schema(&self) -> ValueSchema {
        let value = if self.can_partial_set() {
            partial_struct(&self.value_schema)
        } else {
            self.value_schema.clone()
        };
        s::struct_([("id", s::string()), ("value", value)]).title(&format!("{}Set:Args", self.name))
    }

    /// `Doc.set(value, id?)`: the `<name>Set` event, ready to commit.
    pub fn set(&self, value: impl Into<Val>, id: Option<&str>) -> EventInput {
        EventInput::new(
            self.set_event_name(),
            self.set_args(value, id).to_json_value(),
        )
    }

    /// The decoded args of `Doc.set(value, id?)`.
    pub fn set_args(&self, value: impl Into<Val>, id: Option<&str>) -> Val {
        let id = id
            .map(str::to_string)
            .or_else(|| self.default_id.clone())
            .map_or(Val::Undefined, Val::String);
        Val::obj([("id", id), ("value", value.into())])
    }

    /// Materializer over encoded JSON args: decodes the value optimistically, then [`Self::set_statement`].
    /// Args must already carry the real session id (TS replaces `SessionIdSymbol` before committing).
    #[must_use]
    pub fn set_materializer(&self) -> Materializer {
        let doc = self.clone();
        let schema = create_optimistic_event_schema(
            &self.value_schema,
            &self.default_value,
            self.can_partial_set(),
        );
        Arc::new(move |args, _ctx| {
            let bad = |e: SchemaError| MaterializeError::InvalidArgs {
                event: doc.set_event_name(),
                message: e.0,
            };
            let args = Val::from(args.clone());
            let value = schema
                .decode(args.get("value").cloned().unwrap_or(Val::Undefined))
                .map_err(bad)?;
            let id = args.get("id").cloned().unwrap_or(Val::Undefined);
            Ok(vec![
                doc.set_statement(&Val::obj([("id", id), ("value", value)]))
                    .map_err(bad)?,
            ])
        })
    }

    /// The derived set materializer on decoded args `{ id, value }`.
    ///
    /// # Errors
    ///
    /// Fails when `id` is not a string (the session id was not replaced yet) or the value does not
    /// encode with the document schema.
    pub fn set_statement(&self, args: &Val) -> Result<SqlStatement, SchemaError> {
        let id = match args.get("id") {
            Some(Val::String(id)) => id.clone(),
            _ => {
                return Err(SchemaError(
                    "SessionIdSymbol needs to be replaced before materializing the set event"
                        .into(),
                ));
            }
        };
        let value = args.get("value").cloned().unwrap_or(Val::Undefined);
        let name = &self.name;

        if !self.can_partial_set() {
            let column = s::from_json_string(self.value_schema.clone());
            let insert = if matches!(value, Val::Null | Val::Undefined) {
                self.default_value.clone()
            } else {
                value.clone()
            };
            return Ok(SqlStatement::new(
                format!(
                    "INSERT INTO '{name}' (id, value) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET value = ?"
                ),
                [
                    SqlValue::Text(id),
                    sql_text(column.encode(insert)?),
                    sql_text(column.encode(value)?),
                ],
            ));
        }

        let insert = s::from_json_string(partial_struct(&self.value_schema))
            .encode(merge_default_values(&self.default_value, &value))?;
        let keys: Vec<String> = value
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        let encoded = pick_struct(&self.value_schema, &keys).encode(value)?;
        let mut json_set = "value".to_string();
        let mut binds = vec![SqlValue::Text(id), sql_text(insert)];
        for (key, v) in encoded.as_object().into_iter().flatten() {
            let Some(json) = v.to_json_string() else {
                continue;
            };
            json_set = format!("json_set({json_set}, ?, json(?))");
            binds.extend([SqlValue::Text(format!("$.{key}")), SqlValue::Text(json)]);
        }
        let on_conflict = if binds.len() > 2 {
            format!("ON CONFLICT (id) DO UPDATE SET value = {json_set}")
        } else {
            "ON CONFLICT (id) DO NOTHING".into()
        };
        Ok(SqlStatement::new(
            format!(
                "\n      INSERT INTO '{name}' (id, value)\n      VALUES (?, ?)\n      {on_conflict}\n    "
            ),
            binds,
        ))
    }

    /// `getResultSchema(Doc.get(id))`: decodes the raw result rows to the first row's value.
    #[must_use]
    pub fn get_result_schema(&self) -> ValueSchema {
        s::any().decode_from(
            &s::array(self.row_schema()),
            Arc::new(|rows| match rows {
                Val::Array(rows) => rows
                    .into_iter()
                    .next()
                    .and_then(|row| row.get("value").cloned())
                    .ok_or_else(|| SchemaError("Expected at least one row".into())),
                other => Ok(other),
            }),
            Arc::new(|_| Err(SchemaError("row query results cannot be encoded".into()))),
        )
    }
}

/// `createOptimisticEventSchema`: decodes any value to the current schema, falling back to the
/// compatible fields merged with defaults (full set) or the compatible fields only (partial set).
pub fn create_optimistic_event_schema(
    value_schema: &ValueSchema,
    default_value: &Val,
    partial_set: bool,
) -> ValueSchema {
    let can_partial_set = partial_set && !value_schema.fields().is_empty();
    let target = if can_partial_set {
        partial_struct(value_schema)
    } else {
        value_schema.clone()
    };
    let (value_schema, default_value, encode_target) =
        (value_schema.clone(), default_value.clone(), target.clone());
    let decode = move |event: Val| -> Result<Val, SchemaError> {
        if let Ok(decoded) = encode_target.decode(event.clone()) {
            return encode_target.encode(decoded);
        }
        let Some(entries) = js_entries(&event) else {
            tracing::warn!(
                "Client document: Non-object event value, using {}",
                if can_partial_set {
                    "empty partial"
                } else {
                    "defaults"
                }
            );
            return encode_target.encode(if can_partial_set {
                Val::obj::<String>([])
            } else {
                default_value.clone()
            });
        };
        let known = |key: &String| default_value.get(key).is_some();
        if can_partial_set {
            let partial: IndexMap<String, Val> =
                entries.into_iter().filter(|(k, _)| known(k)).collect();
            if partial.is_empty() {
                return encode_target.encode(Val::obj::<String>([]));
            }
            return if let Ok(decoded) = encode_target.decode(Val::Object(partial)) {
                encode_target.encode(decoded)
            } else {
                tracing::warn!(
                    "Client document: Partial fields incompatible, returning empty partial"
                );
                encode_target.encode(Val::obj::<String>([]))
            };
        }
        let mut merged = default_value.as_object().cloned().unwrap_or_default();
        merged.extend(entries.into_iter().filter(|(k, _)| known(k)));
        if let Ok(decoded) = value_schema.decode(Val::Object(merged)) {
            encode_target.encode(decoded)
        } else {
            tracing::warn!("Client document: Could not preserve event data, using defaults");
            encode_target.encode(default_value.clone())
        }
    };
    target.decode_from(&s::unknown(), Arc::new(decode), Arc::new(Ok))
}

/// `mergeDefaultValues`: shallow merge where `null`/`undefined` explicit values fall back to defaults.
#[must_use]
pub fn merge_default_values(defaults: &Val, explicit: &Val) -> Val {
    let (Val::Object(defaults), Val::Object(explicit_obj)) = (defaults, explicit) else {
        return explicit.clone();
    };
    let mut out = IndexMap::new();
    for key in defaults.keys().chain(explicit_obj.keys()) {
        let value = explicit_obj
            .get(key)
            .filter(|v| !matches!(v, Val::Null | Val::Undefined))
            .or_else(|| defaults.get(key));
        out.insert(key.clone(), value.cloned().unwrap_or(Val::Undefined));
    }
    Val::Object(out)
}

fn partial_struct(schema: &ValueSchema) -> ValueSchema {
    s::struct_(
        schema
            .fields()
            .into_iter()
            .map(|(k, f)| (k, s::optional(f))),
    )
}

fn pick_struct(schema: &ValueSchema, keys: &[String]) -> ValueSchema {
    let fields = schema.fields();
    s::struct_(
        keys.iter()
            .filter_map(|k| fields.iter().find(|(n, _)| n == k).cloned()),
    )
}

/// `Object.entries` for values JS treats as objects; `None` for primitives and `null`.
fn js_entries(value: &Val) -> Option<Vec<(String, Val)>> {
    match value {
        Val::Object(o) => Some(o.clone().into_iter().collect()),
        Val::Array(a) => Some(
            a.iter()
                .cloned()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v))
                .collect(),
        ),
        Val::Bytes(b) => Some(
            b.iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), Val::Number(f64::from(*v))))
                .collect(),
        ),
        Val::Date(_) => Some(vec![]),
        _ => None,
    }
}

fn sql_text(encoded: Val) -> SqlValue {
    match encoded {
        Val::String(s) => SqlValue::Text(s),
        other => SqlValue::Text(other.js_to_string()),
    }
}
