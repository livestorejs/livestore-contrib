//! Port of `schema/state/sqlite/client-document-def.test.ts`.

use livestore_schema::ClientDocument;
use livestore_schema::client_document::{create_optimistic_event_schema, merge_default_values};
use livestore_schema::fingerprint::table_fingerprint;
use livestore_schema::value::{SqlStatement, SqlValue};
use livestore_schema::value_schema::{self as s, Val, ValueSchema};
use serde_json::json;

#[test]
fn tracks_application_value_schema_changes_in_the_storage_fingerprint() {
    let doc = |min| {
        ClientDocument::new(
            "documents",
            s::struct_([("title", s::string().check(s::is_min_length(min)))]),
            val(json!({"title": "valid"})),
        )
        .default_id("default")
    };
    assert_ne!(
        table_fingerprint(&doc(1).table()),
        table_fingerprint(&doc(2).table())
    );
}

/// The TS snapshot patches the event id to a constant; Rust `set` returns only name and args.
#[test]
fn set_event() {
    let ui_state = ClientDocument::new(
        "UiState",
        s::struct_([("showSidebar", s::boolean())]),
        val(json!({"showSidebar": true})),
    );
    assert_eq!(
        ui_state.set(val(json!({"showSidebar": false})), Some("session-1")),
        (
            "UiStateSet".into(),
            val(json!({"id": "session-1", "value": {"showSidebar": false}}))
        )
    );

    let config = s::struct_([
        ("fontSize", s::finite()),
        ("theme", s::literals(["light", "dark"])),
    ]);
    let app_config = ClientDocument::new(
        "AppConfig",
        config,
        val(json!({"fontSize": 13, "theme": "light"})),
    )
    .default_id("static");
    assert_eq!(
        app_config.set(val(json!({"fontSize": 12, "theme": "dark"})), None),
        (
            "AppConfigSet".into(),
            val(json!({"id": "static", "value": {"fontSize": 12, "theme": "dark"}}))
        )
    );
}

#[test]
fn string_value() {
    assert_eq!(
        for_schema(s::string(), Val::from("hello"), None),
        full_replace(r#""hello""#, r#""hello""#)
    );
}

#[test]
fn struct_value_partial_set_true() {
    let stmt = for_schema(
        s::struct_([("a", s::string())]),
        val(json!({"a": "hello"})),
        Some(true),
    );
    assert_eq!(
        stmt,
        partial(
            "ON CONFLICT (id) DO UPDATE SET value = json_set(value, ?, json(?))",
            [r#"{"a":"hello"}"#, "$.a", r#""hello""#]
        )
    );
}

#[test]
fn struct_value_partial_set_false() {
    let stmt = for_schema(
        s::struct_([("a", s::string())]),
        val(json!({"a": "hello"})),
        Some(false),
    );
    assert_eq!(stmt, full_replace(r#"{"a":"hello"}"#, r#"{"a":"hello"}"#));
}

#[test]
fn struct_value_partial_set_true_advanced() {
    let schema = s::struct_([("a", s::string()), ("b", s::string()), ("c", s::finite())]);
    let stmt = for_schema(schema, val(json!({"a": "hello", "c": 123})), Some(true));
    let sql =
        "ON CONFLICT (id) DO UPDATE SET value = json_set(json_set(value, ?, json(?)), ?, json(?))";
    assert_eq!(
        stmt,
        partial(
            sql,
            [
                r#"{"a":"hello","c":123}"#,
                "$.a",
                r#""hello""#,
                "$.c",
                "123"
            ]
        )
    );
}

#[test]
fn struct_value_partial_set_true_explicit_undefined_filters_out_undefined_values() {
    let schema = s::struct_([("a", s::optional(s::string())), ("b", s::string())]);
    let stmt = for_schema(
        schema,
        Val::obj([("a", Val::Undefined), ("b", Val::from("hello"))]),
        Some(true),
    );
    assert_eq!(
        stmt,
        partial(
            "ON CONFLICT (id) DO UPDATE SET value = json_set(value, ?, json(?))",
            [r#"{"b":"hello"}"#, "$.b", r#""hello""#]
        )
    );
}

#[test]
fn struct_value_partial_set_true_explicit_undefined_nothing_to_update() {
    let stmt = for_schema(
        s::struct_([("a", s::optional(s::string()))]),
        Val::obj([("a", Val::Undefined)]),
        Some(true),
    );
    assert_eq!(stmt, partial("ON CONFLICT (id) DO NOTHING", ["{}"]));
}

#[test]
fn struct_union_value() {
    let schema = s::union([
        s::struct_([("a", s::string())]),
        s::struct_([("b", s::string())]),
    ]);
    assert_eq!(
        for_schema(schema, val(json!({"a": "hello"})), None),
        full_replace(r#"{"a":"hello"}"#, r#"{"a":"hello"}"#)
    );
}

#[test]
fn struct_union_with_shared_fields_fully_replaces() {
    let schema = s::union([
        s::struct_([("kind", s::literal("a")), ("value", s::string())]),
        s::struct_([("kind", s::literal("b")), ("value", s::string())]),
    ]);
    let json = r#"{"kind":"a","value":"hello"}"#;
    assert_eq!(
        for_schema(schema, val(json!({"kind": "a", "value": "hello"})), None),
        full_replace(json, json)
    );
}

#[test]
fn array_value() {
    let json = r#"["hello","world"]"#;
    assert_eq!(
        for_schema(s::array(s::string()), val(json!(["hello", "world"])), None),
        full_replace(json, json)
    );
}

#[test]
fn any_value_should_fully_replace() {
    assert_eq!(
        for_schema(s::any(), val(json!({"a": 1})), None),
        full_replace(r#"{"a":1}"#, r#"{"a":1}"#)
    );
}

#[test]
fn decodes_invalid_persisted_json_decoded_shape_json() {
    check_invalid_persisted_json(0);
}

#[test]
fn decodes_invalid_persisted_json_wrong_types() {
    check_invalid_persisted_json(1);
}

#[test]
fn decodes_invalid_persisted_json_missing_required_fields() {
    check_invalid_persisted_json(2);
}

#[test]
fn decodes_valid_persisted_json_encoded_shape() {
    let row_schema = s::from_json_string(create_optimistic_event_schema(
        &value_schema(),
        &default_value(),
        false,
    ));
    assert_eq!(
        row_schema.decode(json_string(&valid_payload())),
        Ok(valid_decoded())
    );
}

#[test]
fn decodes_valid_persisted_json_with_extra_fields() {
    let row_schema = s::from_json_string(create_optimistic_event_schema(
        &value_schema(),
        &default_value(),
        false,
    ));
    let extra = val(json!({"createdAt": 42, "avatar": "AQI=", "extra": "ignored"}));
    assert_eq!(row_schema.decode(json_string(&extra)), Ok(valid_decoded()));
}

#[test]
fn decodes_client_document_row_schema_with_invalid_json_decoded_shape_json() {
    check_row_schema_invalid_json(0);
}

#[test]
fn decodes_client_document_row_schema_with_invalid_json_wrong_types() {
    check_row_schema_invalid_json(1);
}

#[test]
fn decodes_client_document_row_schema_with_invalid_json_missing_required_fields() {
    check_row_schema_invalid_json(2);
}

#[test]
fn decodes_client_document_row_schema_with_valid_encoded_json() {
    let row = Val::obj([
        ("id", Val::from("row-1")),
        ("value", json_string(&valid_payload())),
    ]);
    assert_eq!(
        numbers_doc().row_schema().decode(row),
        Ok(Val::obj([
            ("id", Val::from("row-1")),
            ("value", valid_decoded())
        ]))
    );
}

#[test]
fn decodes_row_query_result_schema_with_invalid_json_decoded_shape_json() {
    check_row_query_invalid_json(0);
}

#[test]
fn decodes_row_query_result_schema_with_invalid_json_wrong_types() {
    check_row_query_invalid_json(1);
}

#[test]
fn decodes_row_query_result_schema_with_invalid_json_missing_required_fields() {
    check_row_query_invalid_json(2);
}

#[test]
fn decodes_row_query_result_schema_with_valid_encoded_json() {
    let rows = Val::Array(vec![Val::obj([
        ("id", Val::from("row-1")),
        ("value", json_string(&valid_payload())),
    ])]);
    assert_eq!(
        numbers_doc().get_result_schema().decode(rows),
        Ok(valid_decoded())
    );
}

#[test]
fn merges_values_from_both_objects() {
    assert_eq!(
        merge(json!({"a": 1, "b": 2}), json!({"a": 10, "b": 20})),
        val(json!({"a": 10, "b": 20}))
    );
}

#[test]
fn uses_default_values_when_explicit_values_are_undefined() {
    let explicit = Val::obj([("a", Val::Undefined), ("b", Val::Number(20.0))]);
    assert_eq!(
        merge_default_values(&val(json!({"a": 1, "b": 2})), &explicit),
        val(json!({"a": 1, "b": 20}))
    );
}

#[test]
fn preserves_properties_that_are_not_in_default_values() {
    let result = merge(json!({"a": 1, "b": 2}), json!({"a": 10, "b": 20, "c": 30}));
    assert_eq!(result, val(json!({"a": 10, "b": 20, "c": 30})));
    assert!(result.get("c").is_some());
}

#[test]
fn issue_487_preserves_optional_fields_not_in_defaults() {
    let result = merge(
        json!({"newTodoText": "", "filter": "all"}),
        json!({"newTodoText": "", "description": "First attempt", "filter": "all"}),
    );
    assert_eq!(
        result,
        val(json!({"newTodoText": "", "description": "First attempt", "filter": "all"}))
    );
    assert!(result.get("description").is_some());
}

#[test]
fn handles_non_object_values() {
    assert_eq!(
        merge(json!("default"), json!("explicit")),
        Val::from("explicit")
    );
    assert_eq!(merge(json!(42), json!(100)), Val::Number(100.0));
    assert_eq!(merge(json!(null), json!({"a": 1})), val(json!({"a": 1})));
    assert_eq!(merge(json!({"a": 1}), json!(null)), Val::Null);
}

#[test]
fn handles_nested_objects_without_deep_merge() {
    assert_eq!(
        merge(
            json!({"a": {"x": 1, "y": 2}, "b": 3}),
            json!({"a": {"x": 10}, "b": 30})
        ),
        val(json!({"a": {"x": 10}, "b": 30}))
    );
}

#[test]
fn handles_mix_of_default_and_new_properties() {
    let result = merge(
        json!({"required1": "default1", "required2": "default2"}),
        json!({"required1": "user1", "required2": "default2", "optional1": "new1", "optional2": "new2"}),
    );
    assert_eq!(
        result,
        val(
            json!({"required1": "user1", "required2": "default2", "optional1": "new1", "optional2": "new2"})
        )
    );
    let mut keys: Vec<&String> = result.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["optional1", "optional2", "required1", "required2"]);
}

fn check_invalid_persisted_json(case: usize) {
    let row_schema = s::from_json_string(create_optimistic_event_schema(
        &value_schema(),
        &default_value(),
        false,
    ));
    let (label, value) = invalid_payloads()[case].clone();
    assert_eq!(
        row_schema.decode(json_string(&value)),
        Ok(default_value()),
        "{label}"
    );
}

fn check_row_schema_invalid_json(case: usize) {
    let (label, value) = invalid_payloads()[case].clone();
    let row = Val::obj([("id", Val::from("row-1")), ("value", json_string(&value))]);
    assert_eq!(
        numbers_doc().row_schema().decode(row),
        Ok(Val::obj([
            ("id", Val::from("row-1")),
            ("value", default_value())
        ])),
        "{label}"
    );
}

fn check_row_query_invalid_json(case: usize) {
    let (label, value) = invalid_payloads()[case].clone();
    let rows = Val::Array(vec![Val::obj([
        ("id", Val::from("row-1")),
        ("value", json_string(&value)),
    ])]);
    assert_eq!(
        numbers_doc().get_result_schema().decode(rows),
        Ok(default_value()),
        "{label}"
    );
}

/// `forSchema`: a `test` document whose default is `value`, materializing `Doc.set(value, id)`.
fn for_schema(schema: ValueSchema, value: Val, partial_set: Option<bool>) -> SqlStatement {
    let doc = ClientDocument::new("test", schema, value.clone());
    let doc = match partial_set {
        Some(p) => doc.partial_set(p),
        None => doc,
    };
    doc.set_statement(&doc.set(value, Some("id1")).1).unwrap()
}

fn full_replace(insert: &str, update: &str) -> SqlStatement {
    SqlStatement::new(
        "INSERT INTO 'test' (id, value) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET value = ?",
        ["id1", insert, update].map(|v| SqlValue::Text(v.into())),
    )
}

fn partial<const N: usize>(on_conflict: &str, binds: [&str; N]) -> SqlStatement {
    let sql = format!(
        "\n      INSERT INTO 'test' (id, value)\n      VALUES (?, ?)\n      {on_conflict}\n    "
    );
    SqlStatement::new(
        sql,
        std::iter::once("id1")
            .chain(binds)
            .map(|v| SqlValue::Text(v.into())),
    )
}

/// Persisted JSON uses epoch numbers + base64 while app code expects `Date` + `Uint8Array`.
fn value_schema() -> ValueSchema {
    s::struct_([
        ("createdAt", s::date_from_millis()),
        ("avatar", s::uint8array_from_base64()),
    ])
}

fn default_value() -> Val {
    Val::obj([
        ("createdAt", Val::Date(0.0)),
        ("avatar", Val::Bytes(vec![])),
    ])
}

fn invalid_payloads() -> [(&'static str, Val); 3] {
    [
        (
            "decoded-shape JSON",
            Val::obj([
                ("createdAt", Val::Date(0.0)),
                ("avatar", Val::Bytes(vec![1, 2])),
            ]),
        ),
        (
            "wrong types",
            val(json!({"createdAt": "not-a-number", "avatar": {"nested": "bad"}})),
        ),
        ("missing required fields", val(json!({}))),
    ]
}

fn valid_payload() -> Val {
    val(json!({"createdAt": 42, "avatar": "AQI="}))
}

fn valid_decoded() -> Val {
    Val::obj([
        ("createdAt", Val::Date(42.0)),
        ("avatar", Val::Bytes(vec![1, 2])),
    ])
}

fn numbers_doc() -> ClientDocument {
    ClientDocument::new("test_numbers", value_schema(), default_value()).partial_set(false)
}

fn json_string(value: &Val) -> Val {
    Val::from(value.to_json_string().unwrap())
}

fn merge(defaults: serde_json::Value, explicit: serde_json::Value) -> Val {
    merge_default_values(&val(defaults), &val(explicit))
}

fn val(v: serde_json::Value) -> Val {
    Val::from(v)
}
