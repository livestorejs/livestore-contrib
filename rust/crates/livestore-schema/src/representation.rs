//! The two serialized views of an Effect schema that LiveStore hashes: the `SchemaRepresentation` document
//! (storage fingerprints of JSON columns) and `JSON.stringify(schema.ast, null, 2)` (`Schema.hash`, the
//! event `schemaHash`). Both mirror Effect 4's output for the schemas [`ValueSchema`] can express.

use serde_json::{Map, Value, json};

use crate::column::ColumnDefault;
use crate::fingerprint::js_numbers;
use crate::value_schema::{Annotation, Ast, Check, Declaration, ValueSchema};

const JSON_MEDIA_TYPE: &str = "application/json";

/// `Schema.hash(schema)` from `@livestore/utils`: Effect's `Hash.string` over the pretty-printed AST.
pub fn schema_hash(schema: &ValueSchema) -> i32 {
    let text = serde_json::to_string_pretty(&js_numbers(&ast_json(schema)))
        .expect("json values serialize");
    hash_string(&text)
}

/// Effect `Hash.string`: djb2 over UTF-16 code units (from the end), then `optimize`.
pub fn hash_string(s: &str) -> i32 {
    let h = s
        .encode_utf16()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .fold(5381i32, |h, c| h.wrapping_mul(33) ^ i32::from(c));
    (h & 0xbfff_ffffu32 as i32) | ((h as u32 >> 1) as i32 & 0x4000_0000)
}

/// `JSON.stringify(schema.ast)` as a JSON value, keys in Effect's order.
pub fn ast_json(schema: &ValueSchema) -> Value {
    let mut out = Map::new();
    out.insert("~effect/Schema".into(), json!("~effect/Schema"));
    let annotations: Map<String, Value> = schema
        .annotations()
        .iter()
        .filter_map(|(k, a)| Some((k.clone(), annotation_json(a)?)))
        .collect();
    if !annotations.is_empty() {
        out.insert("annotations".into(), Value::Object(annotations));
    }
    if !schema.checks().is_empty() {
        out.insert(
            "checks".into(),
            schema.checks().iter().map(check_ast_json).collect(),
        );
    }
    if !schema.links().is_empty() {
        let links = schema.links().iter().map(|link| {
            let transformation = json!({
                "~effect/SchemaTransformation/Transformation": "~effect/SchemaTransformation/Transformation",
                "_tag": "Transformation",
                "decode": { "_tag": link.getters.0 },
                "encode": { "_tag": link.getters.1 },
            });
            json!({ "to": ast_json(&link.from), "transformation": transformation })
        });
        out.insert("encoding".into(), links.collect());
    }
    if schema.is_optional() {
        out.insert(
            "context".into(),
            json!({ "isOptional": true, "isMutable": false }),
        );
    }
    out.insert("_tag".into(), json!(schema.tag()));
    match schema.ast() {
        Ast::Literal(v) => {
            out.insert("literal".into(), v.to_json_value());
        }
        Ast::Enum(values) => {
            out.insert(
                "enums".into(),
                values
                    .iter()
                    .map(|(k, v)| json!([k, v.to_json_value()]))
                    .collect(),
            );
        }
        Ast::Union(members) => {
            out.insert("types".into(), members.iter().map(ast_json).collect());
        }
        Ast::Objects(fields) => {
            out.insert(
                "propertySignatures".into(),
                fields
                    .iter()
                    .map(|(k, f)| json!({ "name": k, "type": ast_json(f) }))
                    .collect(),
            );
            out.insert("indexSignatures".into(), json!([]));
        }
        Ast::Record(value) => {
            out.insert("propertySignatures".into(), json!([]));
            out.insert("indexSignatures".into(), json!([{ "parameter": ast_json(&crate::value_schema::string()), "type": ast_json(value) }]));
        }
        Ast::Arrays { elements, rest } => {
            out.insert("isMutable".into(), json!(false));
            out.insert("elements".into(), elements.iter().map(ast_json).collect());
            out.insert("rest".into(), rest.iter().map(ast_json).collect());
        }
        Ast::Declaration(d) => {
            out.insert(
                "typeParameters".into(),
                type_parameters(d).iter().map(ast_json).collect(),
            );
        }
        _ => {}
    }
    Value::Object(out)
}

/// `SchemaRepresentation.toRepresentations([ast, toType(ast)])` with references inlined. Annotations and the
/// `content.schema` of JSON strings are left out: storage fingerprints ignore both.
pub fn representation_document(schema: &ValueSchema) -> Value {
    json!({ "representations": [representation(schema), representation(&schema.to_type())], "references": {} })
}

/// `hasJsonStringEncoding`: the encoded side is a JSON string (or a union with one).
pub fn has_json_string_encoding(schema: &ValueSchema) -> bool {
    let (node, json) = most_encoded(schema);
    json || matches!(node.ast(), Ast::Union(members) if members.iter().any(has_json_string_encoding))
}

fn representation(schema: &ValueSchema) -> Value {
    let (node, json) = most_encoded(schema);
    let mut out = Map::new();
    out.insert("_tag".into(), json!(node.tag()));
    if json {
        out.insert("content".into(), json!({ "mediaType": JSON_MEDIA_TYPE }));
    }
    out.insert(
        "checks".into(),
        node.checks().iter().map(check_representation).collect(),
    );
    match node.ast() {
        Ast::Literal(v) => {
            out.insert("literal".into(), v.to_json_value());
        }
        Ast::Enum(values) => {
            out.insert(
                "enums".into(),
                values
                    .iter()
                    .map(|(k, v)| json!([k, v.to_json_value()]))
                    .collect(),
            );
        }
        Ast::Union(members) => {
            out.insert("types".into(), members.iter().map(representation).collect());
        }
        Ast::Objects(fields) => {
            let properties = fields
                .iter()
                .map(|(k, f)| json!({ "name": k, "type": representation(f), "isOptional": f.is_optional(), "isMutable": false }));
            out.insert("propertySignatures".into(), properties.collect());
            out.insert("indexSignatures".into(), json!([]));
        }
        Ast::Record(value) => {
            out.insert("propertySignatures".into(), json!([]));
            let parameter = representation(&crate::value_schema::string());
            out.insert(
                "indexSignatures".into(),
                json!([{ "parameter": parameter, "type": representation(value) }]),
            );
        }
        Ast::Arrays { elements, rest } => {
            let elements = elements
                .iter()
                .map(|e| json!({ "isOptional": e.is_optional(), "type": representation(e) }));
            out.insert("elements".into(), elements.collect());
            out.insert("rest".into(), rest.iter().map(representation).collect());
        }
        Ast::Declaration(d) => {
            out.insert(
                "typeParameters".into(),
                type_parameters(d).iter().map(representation).collect(),
            );
            if let Some(Annotation::Json(r)) = node.annotation("representation") {
                out.insert("representation".into(), r.clone());
            }
        }
        Ast::Suspend(thunk) => {
            out.insert("checks".into(), json!([]));
            out.insert("thunk".into(), representation(&thunk()));
        }
        _ => {}
    }
    Value::Object(out)
}

/// Follows the encoding chain to its end; `true` when the last step produces a JSON string.
fn most_encoded(schema: &ValueSchema) -> (ValueSchema, bool) {
    let mut node = schema.clone();
    let mut json = false;
    while let Some(link) = node.links().last() {
        json = link.json && !link.from.has_encoding() && matches!(link.from.ast(), Ast::String);
        node = link.from.clone();
    }
    (node, json)
}

fn type_parameters(declaration: &Declaration) -> Vec<ValueSchema> {
    match declaration {
        Declaration::Class(_, fields) => vec![fields.clone()],
        _ => vec![],
    }
}

fn check_ast_json(check: &Check) -> Value {
    match &check.annotations {
        Value::Null => json!({ "_tag": "Filter", "aborted": false }),
        annotations => json!({ "_tag": "Filter", "annotations": annotations, "aborted": false }),
    }
}

fn check_representation(check: &Check) -> Value {
    match check.annotations.get("representation") {
        Some(r) => json!({ "_tag": "Filter", "aborted": false, "representation": r }),
        None => json!({ "_tag": "Filter", "aborted": false }),
    }
}

/// `JSON.stringify` drops functions, so thunk defaults vanish.
fn annotation_json(annotation: &Annotation) -> Option<Value> {
    match annotation {
        Annotation::Bool(b) => Some(json!(b)),
        Annotation::Str(s) => Some(json!(s)),
        Annotation::Json(v) => Some(v.clone()),
        Annotation::Default(ColumnDefault::Value(v)) => Some(v.to_json_value()),
        Annotation::Default(ColumnDefault::Sql(sql)) => Some(json!({ "sql": sql })),
        Annotation::Default(ColumnDefault::Thunk(_)) => None,
    }
}
