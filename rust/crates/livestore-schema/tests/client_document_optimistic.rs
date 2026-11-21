//! Port of `tests/package-common/src/client-document-optimistic-schema.test.ts`.

use livestore_schema::client_document::create_optimistic_event_schema;
use livestore_schema::value_schema::{self as s, Val, ValueSchema};
use serde_json::json;

#[test]
fn accepts_current_schema_events() {
    let current = val(json!({"name": "Alice", "age": 30, "email": "alice@example.com"}));
    assert_eq!(full().decode(current.clone()), Ok(current));
}

#[test]
fn adds_missing_required_fields_from_defaults() {
    assert_eq!(
        full().decode(val(json!({"name": "Bob", "age": 35}))),
        Ok(val(
            json!({"name": "Bob", "age": 35, "email": "user@example.com"})
        ))
    );
}

#[test]
fn drops_removed_fields() {
    let old = val(
        json!({"name": "Charlie", "age": 40, "email": "charlie@example.com", "oldField": "data"}),
    );
    assert_eq!(
        full().decode(old),
        Ok(val(
            json!({"name": "Charlie", "age": 40, "email": "charlie@example.com"})
        ))
    );
}

#[test]
fn uses_defaults_for_type_mismatches() {
    assert_eq!(
        full().decode(val(
            json!({"name": "Dave", "age": "thirty", "email": "dave@example.com"})
        )),
        Ok(full_default())
    );
}

#[test]
fn handles_non_object_events() {
    for event in [json!(null), json!("string"), json!(123)] {
        assert_eq!(full().decode(val(event)), Ok(full_default()));
    }
}

#[test]
fn accepts_partial_updates() {
    assert_eq!(
        partial().decode(val(json!({"field1": "updated"}))),
        Ok(val(json!({"field1": "updated"})))
    );
}

#[test]
fn filters_out_unknown_fields() {
    assert_eq!(
        partial().decode(val(json!({"field1": "updated", "unknownField": "data"}))),
        Ok(val(json!({"field1": "updated"})))
    );
}

#[test]
fn returns_empty_object_for_incompatible_partials() {
    assert_eq!(
        partial().decode(val(json!({"field2": "not-a-number"}))),
        Ok(val(json!({})))
    );
}

#[test]
fn handles_multiple_fields_with_mixed_compatibility() {
    assert_eq!(
        partial().decode(val(json!({"field1": "valid", "field2": 42}))),
        Ok(val(json!({"field1": "valid", "field2": 42})))
    );
}

#[test]
fn handles_non_object_values() {
    for value in [Val::Null, Val::Undefined, Val::Array(vec![])] {
        assert_eq!(partial().decode(value), Ok(val(json!({}))));
    }
}

fn full() -> ValueSchema {
    let value_schema = s::struct_([
        ("name", s::string()),
        ("age", s::finite()),
        ("email", s::string()),
    ]);
    create_optimistic_event_schema(&value_schema, &full_default(), false)
}

fn full_default() -> Val {
    val(json!({"name": "User", "age": 25, "email": "user@example.com"}))
}

fn partial() -> ValueSchema {
    let value_schema = s::struct_([("field1", s::string()), ("field2", s::finite())]);
    create_optimistic_event_schema(
        &value_schema,
        &val(json!({"field1": "default1", "field2": 0})),
        true,
    )
}

fn val(v: serde_json::Value) -> Val {
    Val::from(v)
}
