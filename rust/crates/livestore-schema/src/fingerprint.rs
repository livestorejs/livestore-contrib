//! Storage fingerprints (`db-schema/ast/fingerprint.ts`): SHA-256 over a canonical JSON descriptor,
//! base64url without padding. JSON columns hash their Effect `SchemaRepresentation` document.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::representation::{has_json_string_encoding, representation_document};
use crate::table::{Column, ColumnType, DefaultValue, Index, Table};
use crate::value_schema::Val;

const DOMAIN: &str = "livestore/state-storage-fingerprint";

/// Effect metadata fields that must not affect fingerprints.
const EFFECT_IGNORED_FIELDS: &[&str] = &["annotations", "isMutable", "content"];

/// Renamed Effect check ids mapped back to the ids existing fingerprints were computed from.
const RENAMED_EFFECT_CHECK_IDS: &[(&str, &str)] = &[
    (
        "effect/schema/isBetweenLength",
        "effect/schema/isLengthBetween",
    ),
    ("effect/schema/isStartingWith", "effect/schema/isStartsWith"),
    ("effect/schema/isEndingWith", "effect/schema/isEndsWith"),
    ("effect/schema/isIncluding", "effect/schema/isIncludes"),
    ("effect/schema/isBetweenSize", "effect/schema/isSizeBetween"),
    (
        "effect/schema/isBetweenProperties",
        "effect/schema/isPropertiesLengthBetween",
    ),
];

/// `fingerprint(tableAst)`.
pub fn table_fingerprint(table: &Table) -> String {
    digest(json!([DOMAIN, table_descriptor(table)]))
}

/// `fingerprint({ _tag: 'dbSchema', tables })`.
pub fn db_fingerprint<'a>(tables: impl IntoIterator<Item = &'a Table>) -> String {
    let mut tables: Vec<(String, Value)> = tables
        .into_iter()
        .map(|t| (js_stringify(&json!(t.name)), table_descriptor(t)))
        .collect();
    tables.sort_by(|a, b| a.0.cmp(&b.0));
    digest(json!([
        DOMAIN,
        [
            "database",
            tables.into_iter().map(|(_, t)| t).collect::<Vec<_>>()
        ]
    ]))
}

/// `digestToFingerprint`.
pub fn digest_to_fingerprint(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}

/// `JSON.stringify` for canonical values (integral floats print without a fraction).
pub fn js_stringify(value: &Value) -> String {
    serde_json::to_string(&js_numbers(value)).expect("json values serialize")
}

fn digest(descriptor: Value) -> String {
    digest_to_fingerprint(js_stringify(&descriptor).as_bytes())
}

fn table_descriptor(table: &Table) -> Value {
    let mut indexes: Vec<Value> = table.indexes.iter().map(index_descriptor).collect();
    sort_canonical(&mut indexes);
    json!([
        "table",
        table.name,
        table
            .columns
            .iter()
            .map(column_descriptor)
            .collect::<Vec<_>>(),
        indexes
    ])
}

fn index_descriptor(index: &Index) -> Value {
    json!(["index", index.name, index.unique, false, index.columns])
}

fn column_descriptor(column: &Column) -> Value {
    let ty = match column.ty {
        ColumnType::Text => "text",
        ColumnType::Integer => "integer",
        ColumnType::Real => "real",
        ColumnType::Blob => "blob",
    };
    let default = match &column.default {
        None => json!(["none"]),
        Some(DefaultValue::Thunk(_)) => json!(["runtime-default"]),
        Some(DefaultValue::Value(Val::Null)) => json!(["value", null]),
        Some(DefaultValue::Sql(sql)) => json!(["sql", sql]),
        Some(DefaultValue::Value(v)) => json!([
            "value",
            column
                .schema
                .encode(v.clone())
                .map(|e| e.to_json_value())
                .unwrap_or(Value::Null)
        ]),
    };
    let schema = match &column.schema_repr {
        Some(repr) => json!(["schema", representation_descriptor(repr, None)]),
        None if has_json_string_encoding(&column.schema) => json!([
            "schema",
            representation_descriptor(&representation_document(&column.schema), None)
        ]),
        None => Value::Null,
    };
    json!([
        "column",
        column.name,
        ty,
        column.primary_key,
        column.nullable,
        column.auto_increment,
        default,
        schema
    ])
}

/// `schemaRepresentationDescriptor`: sorted keys, Effect metadata dropped, renamed check ids restored.
fn representation_descriptor(value: &Value, parent_key: Option<&str>) -> Value {
    if parent_key == Some("payload") {
        return canonical(value);
    }
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| representation_descriptor(v, None))
                .collect(),
        ),
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map
                .iter()
                .map(|(k, v)| match (parent_key, k.as_str(), v.as_str()) {
                    (Some("representation"), "id", Some(id)) => {
                        let id = RENAMED_EFFECT_CHECK_IDS
                            .iter()
                            .find(|(new, _)| *new == id)
                            .map_or(id, |(_, old)| old);
                        (k.clone(), json!(id))
                    }
                    _ => (k.clone(), v.clone()),
                })
                .collect();
            if map.get("_tag") == Some(&json!("Union")) && !map.contains_key("mode") {
                entries.push(("mode".into(), json!("anyOf")));
            }
            entries.retain(|(k, _)| !EFFECT_IGNORED_FIELDS.contains(&k.as_str()));
            sort_entries(&mut entries);
            Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| {
                        let d = representation_descriptor(&v, Some(&k));
                        (k, d)
                    })
                    .collect(),
            )
        }
        other => canonical(other),
    }
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> =
                map.iter().map(|(k, v)| (k.clone(), canonical(v))).collect();
            sort_entries(&mut entries);
            Value::Object(entries.into_iter().collect::<Map<_, _>>())
        }
        other => other.clone(),
    }
}

fn sort_entries(entries: &mut [(String, Value)]) {
    entries.sort_by_cached_key(|(k, _)| js_stringify(&json!(k)));
}

fn sort_canonical(values: &mut [Value]) {
    values.sort_by_cached_key(js_stringify);
}

pub(crate) fn js_numbers(value: &Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => json!(f as i64),
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(js_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), js_numbers(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}
