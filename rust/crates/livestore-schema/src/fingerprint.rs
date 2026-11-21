//! Schema hashes. Table fingerprints follow core's descriptor (`db-schema/ast/fingerprint.ts`): SHA-256 over
//! a canonical JSON array, base64url without padding. Where core hashes Effect's `SchemaRepresentation`, Rust
//! hashes its own description of the [`ValueSchema`]. Hashes never leave the device, so they only have to
//! stay the same from run to run, not match TypeScript.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::table::{Column, ColumnType, DefaultValue, Index, Table};
use crate::value_schema::{Annotation, Ast, Declaration, Val, ValueSchema};

const DOMAIN: &str = "livestore/state-storage-fingerprint";

/// The event `schemaHash`: the first four bytes of the SHA-256 of the schema description.
pub fn schema_hash(schema: &ValueSchema) -> i32 {
    let digest = Sha256::digest(js_stringify(&describe(schema)).as_bytes());
    i32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// A canonical JSON description of a schema. Annotations other than a declaration's `representation`
/// are left out, so documentation does not change a hash.
pub fn describe(schema: &ValueSchema) -> Value {
    describe_in(schema, &mut Vec::new())
}

/// The encoded side is a JSON string, or a union with one.
pub fn has_json_string_encoding(schema: &ValueSchema) -> bool {
    let mut node = schema.clone();
    let mut json = false;
    while let Some(link) = node.links().last() {
        json = link.json && !link.from.has_encoding() && matches!(link.from.ast(), Ast::String);
        node = link.from.clone();
    }
    json || matches!(node.ast(), Ast::Union(members) if members.iter().any(has_json_string_encoding))
}

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
                .map_or(Value::Null, |e| e.to_json_value())
        ]),
    };
    let schema = if has_json_string_encoding(&column.schema) {
        json!(["schema", describe(&column.schema)])
    } else {
        Value::Null
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

fn describe_in(schema: &ValueSchema, cycle: &mut Vec<&'static str>) -> Value {
    let checks: Vec<Value> = schema
        .checks()
        .iter()
        .map(|c| match c.annotations.get("representation") {
            Some(r) => r.clone(),
            None => json!(c.message),
        })
        .collect();
    let encoding: Vec<Value> = schema
        .links()
        .iter()
        .map(|l| {
            json!([
                l.json,
                l.getters.0,
                l.getters.1,
                describe_in(&l.from, cycle)
            ])
        })
        .collect();
    let node = match schema.ast() {
        Ast::Literal(v) => json!(["literal", v.to_json_value()]),
        Ast::Enum(values) => json!([
            "enum",
            values
                .iter()
                .map(|(k, v)| json!([k, v.to_json_value()]))
                .collect::<Vec<_>>()
        ]),
        Ast::Union(members) => json!([
            "union",
            members
                .iter()
                .map(|m| describe_in(m, cycle))
                .collect::<Vec<_>>()
        ]),
        Ast::Objects(fields) => json!([
            "struct",
            fields
                .iter()
                .map(|(k, f)| json!([k, describe_in(f, cycle)]))
                .collect::<Vec<_>>()
        ]),
        Ast::Record(value) => json!(["record", describe_in(value, cycle)]),
        Ast::Arrays { elements, rest } => json!([
            "array",
            elements
                .iter()
                .map(|e| describe_in(e, cycle))
                .collect::<Vec<_>>(),
            rest.as_ref().map(|r| describe_in(r, cycle))
        ]),
        Ast::Declaration(d) => {
            let representation = match schema.annotation("representation") {
                Some(Annotation::Json(r)) => r.clone(),
                _ => Value::Null,
            };
            match d {
                Declaration::Date => json!(["declaration", "Date", representation]),
                Declaration::Uint8Array => json!(["declaration", "Uint8Array", representation]),
                Declaration::Class(_, fields) => {
                    json!(["class", describe_in(fields, cycle), representation])
                }
            }
        }
        Ast::Suspend(name, thunk) => match cycle.iter().position(|n| n == name) {
            Some(depth) => json!(["recursive", depth]),
            None => {
                cycle.push(name);
                let inner = describe_in(&thunk(), cycle);
                cycle.pop();
                json!(["suspend", inner])
            }
        },
        _ => json!([schema.tag()]),
    };
    json!([node, checks, encoding, schema.is_optional()])
}
