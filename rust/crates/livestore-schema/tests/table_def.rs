//! Port of `schema/state/sqlite/table-def.test.ts` and `schema-helpers.test.ts`.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use indexmap::IndexMap;
use livestore_schema::column::{Column, ColumnDefault, ColumnType, with_primary_key, with_unique};
use livestore_schema::table::{Index, Table};
use livestore_schema::value_schema::{self as s, Val, ValueSchema};
use serde_json::json;

const ISO: &str = "2026-01-02T03:04:05.678Z";
const MS: f64 = 1_767_323_045_678.0;

#[test]
fn extracts_table_name_from_title_annotation() {
    let table = Table::from_schema(None, &todo_schema().title("todos"), vec![]).unwrap();
    assert_eq!(table.name, "todos");
}

#[test]
fn extracts_table_name_from_identifier_annotation() {
    let table = Table::from_schema(None, &todo_schema().identifier("TodoItem"), vec![]).unwrap();
    assert_eq!(table.name, "TodoItem");
}

#[test]
fn prefers_title_over_identifier_annotation() {
    let table = Table::from_schema(
        None,
        &todo_schema().title("todos").identifier("TodoItem"),
        vec![],
    )
    .unwrap();
    assert_eq!(table.name, "todos");
}

#[test]
fn throws_when_schema_has_no_name_title_or_identifier() {
    let err = Table::from_schema(None, &todo_schema(), vec![]).unwrap_err();
    assert_eq!(
        err.to_string(),
        "When using schema without explicit name, the schema must have a title or identifier annotation"
    );
}

#[test]
fn works_with_columns_parameter() {
    let table = Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""))
        .column(Column::boolean("completed").default(false))
        .column(Column::boolean("optionalBoolean").default(false).nullable())
        .column(
            Column::json("optionalComplex")
                .nullable()
                .schema(s::undefined_or(s::struct_([("color", s::string())]))),
        );
    assert_eq!(table.name, "todos");
    for name in ["id", "text", "completed", "optionalComplex"] {
        assert!(table.columns.iter().any(|c| c.name == name));
    }
    assert!(table.col("optionalBoolean").nullable);
    assert_eq!(
        table.col("optionalBoolean").schema.encode(Val::Bool(false)),
        Ok(Val::Number(0.0))
    );
    assert!(table.col("optionalComplex").nullable);

    let row = table.row_schema();
    let encoded = val(
        json!({"id": "todo-1", "text": "Buy milk", "completed": 1, "optionalBoolean": null, "optionalComplex": r#"{"color":"red"}"#}),
    );
    let decoded = val(
        json!({"id": "todo-1", "text": "Buy milk", "completed": true, "optionalBoolean": null, "optionalComplex": {"color": "red"}}),
    );
    assert_eq!(row.decode(encoded), Ok(decoded));
    let encoded = val(
        json!({"id": "todo-1", "text": "Buy milk", "completed": 0, "optionalBoolean": null, "optionalComplex": null}),
    );
    let decoded = val(
        json!({"id": "todo-1", "text": "Buy milk", "completed": false, "optionalBoolean": null, "optionalComplex": null}),
    );
    assert_eq!(row.decode(encoded), Ok(decoded));
}

/// The TS test is about explicit generic arguments; Rust tables are not generic, so the runtime part is ported.
#[test]
fn allows_explicit_first_two_generic_arguments_without_options_generic() {
    let table = Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""));
    assert_eq!(table.name, "todos");
    assert!(table.columns.iter().any(|c| c.name == "id"));
    assert!(table.columns.iter().any(|c| c.name == "text"));
}

#[test]
fn works_with_schema_parameter() {
    let table = Table::from_schema(Some("todos"), &todo_schema(), vec![]).unwrap();
    assert_eq!(table.name, "todos");
    let names: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "text", "completed"]);
}

#[test]
fn works_with_single_column() {
    let table = Table::single_column("simple", Column::text("").primary_key());
    assert_eq!(table.name, "simple");
    assert!(table.col("value").primary_key);
}

#[test]
fn handles_optional_fields_in_schema() {
    let user = s::struct_([
        ("id", s::string()),
        ("name", s::string()),
        ("email", s::optional(s::string())),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert!(!table.col("id").nullable);
    assert!(!table.col("name").nullable);
    assert!(table.col("email").nullable);
}

#[test]
fn keeps_a_date_codec_so_the_column_round_trips_through_its_encoded_form() {
    let stamp = s::struct_([
        ("id", with_primary_key(&s::string())),
        ("createdAt", s::date_from_string()),
        ("seenAt", s::date_from_millis()),
        ("bornAt", s::date()),
        ("deletedAt", s::null_or(s::date_from_string())),
        ("archivedAt", s::optional(s::date_from_string())),
    ]);
    let table = Table::from_schema(Some("stamps"), &stamp, vec![]).unwrap();
    let date = Val::Date(MS);
    let round_trip = |name: &str, v: Val| {
        let schema = &table.col(name).schema;
        schema.decode(schema.encode(v).unwrap()).unwrap()
    };

    assert_eq!(table.col("createdAt").ty, ColumnType::Text);
    assert_eq!(
        table.col("createdAt").schema.encode(date.clone()),
        Ok(Val::from(ISO))
    );
    assert_eq!(round_trip("createdAt", date.clone()), date);

    assert_eq!(table.col("seenAt").ty, ColumnType::Integer);
    assert_eq!(
        table.col("seenAt").schema.encode(date.clone()),
        Ok(Val::Number(MS))
    );
    assert_eq!(round_trip("seenAt", date.clone()), date);

    assert_eq!(table.col("bornAt").ty, ColumnType::Text);
    assert_eq!(
        table.col("bornAt").schema.encode(date.clone()),
        Ok(Val::from(ISO))
    );
    assert_eq!(round_trip("bornAt", date.clone()), date);

    assert!(table.col("deletedAt").nullable);
    assert_eq!(round_trip("deletedAt", date.clone()), date);
    assert_eq!(round_trip("deletedAt", Val::Null), Val::Null);

    assert!(table.col("archivedAt").nullable);
    assert_eq!(round_trip("archivedAt", date.clone()), date);
}

#[test]
fn stores_a_codec_field_in_its_encoded_form_like_get_column_def_for_schema_does() {
    let table = Table::from_schema(
        Some("counters"),
        &s::struct_([("id", s::string()), ("count", s::finite_from_string())]),
        vec![],
    )
    .unwrap();
    assert_eq!(table.col("count").ty, ColumnType::Text);
    assert_eq!(
        table.col("count").schema.encode(Val::Number(42.0)),
        Ok(Val::from("42"))
    );
    assert_eq!(
        table.col("count").schema.decode(Val::from("42")),
        Ok(Val::Number(42.0))
    );
}

#[test]
fn handles_schema_int_as_integer_column() {
    let table = Table::from_schema(
        Some("counters"),
        &s::struct_([("id", s::string()), ("count", s::int())]),
        vec![],
    )
    .unwrap();
    assert_eq!(table.col("count").ty, ColumnType::Integer);
}

#[test]
fn works_with_schema_class() {
    let user = s::class(
        "User",
        s::struct_([
            ("id", s::string()),
            ("name", s::string()),
            ("email", s::optional(s::string())),
            ("age", s::int()),
        ]),
    );
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert_eq!(table.name, "users");
    let names: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "name", "email", "age"]);
    assert_eq!(table.col("id").ty, ColumnType::Text);
    assert_eq!(table.col("name").ty, ColumnType::Text);
    assert_eq!(table.col("email").ty, ColumnType::Text);
    assert!(table.col("email").nullable);
    assert_eq!(table.col("age").ty, ColumnType::Integer);
}

#[test]
fn preserves_date_field_codecs_in_schema_class_tables() {
    let stamp = s::class(
        "Stamp",
        s::struct_([
            ("id", s::string()),
            ("createdAt", s::date_from_string()),
            ("seenAt", s::date_from_millis()),
        ]),
    );
    let table = Table::from_schema(Some("stamps"), &stamp, vec![]).unwrap();
    let date = Val::Date(MS);
    assert_eq!(table.col("createdAt").ty, ColumnType::Text);
    assert_eq!(
        table.col("createdAt").schema.decode(Val::from(ISO)),
        Ok(date.clone())
    );
    assert_eq!(
        table.col("createdAt").schema.encode(date.clone()),
        Ok(Val::from(ISO))
    );
    assert_eq!(table.col("seenAt").ty, ColumnType::Integer);
    assert_eq!(
        table.col("seenAt").schema.decode(Val::Number(MS)),
        Ok(date.clone())
    );
    assert_eq!(table.col("seenAt").schema.encode(date), Ok(Val::Number(MS)));
}

#[test]
fn supports_schemas_that_transform_flat_columns_into_nested_types() {
    let flat = s::struct_([
        ("id", with_primary_key(&s::string())),
        ("contactFirstName", s::string()),
        ("contactLastName", s::string()),
        ("contactEmail", with_unique(&s::string())),
    ]);
    let contact = s::struct_([
        ("firstName", s::string()),
        ("lastName", s::string()),
        ("email", s::string()),
    ]);
    let nested = s::struct_([("id", s::string()), ("contact", contact)]).decode_from(
        &flat,
        Arc::new(|v| {
            let f = |k: &str| v.get(k).cloned().unwrap_or(Val::Undefined);
            let contact = Val::obj([
                ("firstName", f("contactFirstName")),
                ("lastName", f("contactLastName")),
                ("email", f("contactEmail")),
            ]);
            Ok(Val::obj([("id", f("id")), ("contact", contact)]))
        }),
        Arc::new(|v| {
            let c = |k: &str| {
                v.get("contact")
                    .and_then(|c| c.get(k))
                    .cloned()
                    .unwrap_or(Val::Undefined)
            };
            Ok(Val::obj([
                ("id", v.get("id").cloned().unwrap_or(Val::Undefined)),
                ("contactFirstName", c("firstName")),
                ("contactLastName", c("lastName")),
                ("contactEmail", c("email")),
            ]))
        }),
    );
    let table = Table::from_schema(Some("contacts"), &nested, vec![]).unwrap();
    let names: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        ["id", "contactFirstName", "contactLastName", "contactEmail"]
    );
    assert!(table.col("id").primary_key);
    assert_eq!(table.col("contactEmail").ty, ColumnType::Text);
    assert!(table.indexes.contains(&Index {
        name: "idx_contacts_contactEmail_unique".into(),
        columns: vec!["contactEmail".into()],
        unique: true
    }));
}

#[test]
fn extracts_table_name_from_schema_class_identifier() {
    let todo = s::class(
        "TodoItem",
        s::struct_([
            ("id", s::string()),
            ("text", s::string()),
            ("completed", s::boolean()),
        ]),
    );
    let table = Table::from_schema(Some("TodoItem"), &todo, vec![]).unwrap();
    assert_eq!(table.name, "TodoItem");
}

/// The TS compile-time row/column type checks have no analogue for dynamic `Val` rows; the runtime part is ported.
#[test]
fn properly_infers_types_from_schema() {
    let user = s::struct_([
        ("id", s::string()),
        ("name", s::string()),
        ("age", s::int()),
        ("active", s::boolean()),
        ("metadata", s::optional(s::record(s::unknown()))),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert_eq!(table.col("id").ty, ColumnType::Text);
    assert_eq!(table.col("name").ty, ColumnType::Text);
    assert_eq!(table.col("age").ty, ColumnType::Integer);
    assert_eq!(table.col("active").ty, ColumnType::Integer);
    assert_eq!(table.col("metadata").ty, ColumnType::Text);
    assert!(table.col("metadata").nullable);

    let encoded = val(
        json!({"id": "test-id", "name": "John", "age": 30, "active": 1, "metadata": r#"{"key1":"value1","key2":123}"#}),
    );
    let decoded = val(
        json!({"id": "test-id", "name": "John", "age": 30, "active": true, "metadata": {"key1": "value1", "key2": 123}}),
    );
    assert_eq!(table.row_schema().decode(encoded), Ok(decoded));
    assert_eq!(
        table.col("active").schema.decode(Val::Number(0.0)),
        Ok(Val::Bool(false))
    );
    assert_eq!(
        table.col("metadata").schema.decode(Val::Null),
        Ok(Val::Null)
    );
}

/// `expectTypeOf(...).toBeCallableWith` has no Rust analogue (insert values are dynamic); each runtime `insert().asSql()` is ported.
#[test]
fn allows_omitting_nullable_fields_in_insert() {
    let user = s::struct_([
        ("id", with_primary_key(&s::string())),
        ("undefined", s::undefined()),
        ("null", s::null()),
        ("undefinedOrString", s::undefined_or(s::string())),
        ("nullOrString", s::null_or(s::string())),
        ("optionalString", s::optional(s::string())),
        ("optionalNullOrString", s::optional(s::null_or(s::string()))),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    let full = [
        ("id", Val::from("1")),
        ("undefined", Val::Undefined),
        ("null", Val::Null),
        ("undefinedOrString", Val::Undefined),
        ("nullOrString", Val::Null),
        ("optionalString", Val::from("string")),
        ("optionalNullOrString", Val::Null),
    ];
    let variants: Vec<Vec<(&str, Val)>> = vec![
        full[..1].to_vec(),
        full[..2].to_vec(),
        full[..3].to_vec(),
        full[..4].to_vec(),
        with(&full[..4], "undefinedOrString", "string"),
        with(&full[..5], "undefinedOrString", "string"),
        with(
            &with(&full[..5], "undefinedOrString", "string"),
            "nullOrString",
            "string",
        ),
        with(
            &with(&full[..6], "undefinedOrString", "string"),
            "nullOrString",
            "string",
        ),
        with(
            &with(&full[..7], "undefinedOrString", "string"),
            "nullOrString",
            "string",
        ),
        with(
            &with(
                &with(&full[..7], "undefinedOrString", "string"),
                "nullOrString",
                "string",
            ),
            "optionalNullOrString",
            "string",
        ),
    ];
    for values in variants {
        assert!(
            table.encode_insert_values(Val::obj(values.clone())).is_ok(),
            "{values:?}"
        );
    }
}

#[test]
fn supports_discriminated_unions_with_parsed_json_payloads() {
    let circle = s::struct_([
        ("kind", s::literal("circle")),
        (
            "data",
            s::from_json_string(s::struct_([("radius", s::finite())])),
        ),
    ]);
    let square = s::struct_([
        ("kind", s::literal("square")),
        (
            "data",
            s::from_json_string(s::struct_([("sideLength", s::finite())])),
        ),
    ]);
    let shapes = Table::from_schema(Some("shapes"), &s::union([circle, square]), vec![]).unwrap();
    assert_eq!(shapes.col("kind").ty, ColumnType::Text);
    assert_eq!(shapes.col("kind").schema.to_encoded().tag(), "Union");
    assert!(
        shapes
            .encode_insert_values(val(json!({"kind": "square", "data": {"sideLength": 10}})))
            .is_ok()
    );
    assert!(
        shapes
            .encode_insert_values(val(json!({"kind": "circle", "data": {"radius": 5}})))
            .is_ok()
    );
}

#[test]
fn treats_optional_common_union_fields_as_nullable_columns() {
    let state = s::union([
        s::struct_([
            ("kind", s::literal("empty")),
            ("note", s::optional(s::string())),
        ]),
        s::struct_([
            ("kind", s::literal("ready")),
            ("note", s::optional(s::string())),
        ]),
    ]);
    let states = Table::from_schema(Some("states"), &state, vec![]).unwrap();
    assert_eq!(states.col("kind").ty, ColumnType::Text);
    assert_eq!(states.col("note").ty, ColumnType::Text);
    assert!(states.col("note").nullable);
}

#[test]
fn resolves_thunk_defaults_when_decoding_values() {
    let (table, counter) = sessions_table("sessions", "token");
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    let first = table.default_values_decoded(&IndexMap::new());
    let second = table.default_values_decoded(&IndexMap::new());
    assert_eq!(first["token"], Val::from("token-1"));
    assert_eq!(second["token"], Val::from("token-2"));
}

#[test]
fn resolves_thunk_defaults_when_encoding_values() {
    let (table, counter) = sessions_table("sessions_encoded", "encoded");
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    let first = table.default_values_encoded(&IndexMap::new());
    let second = table.default_values_encoded(&IndexMap::new());
    assert_eq!(first["token"], Val::from("encoded-1"));
    assert_eq!(second["token"], Val::from("encoded-2"));
}

fn todo_schema() -> ValueSchema {
    s::struct_([
        ("id", s::string()),
        ("text", s::string()),
        ("completed", s::boolean()),
    ])
}

fn sessions_table(name: &str, prefix: &'static str) -> (Table, Arc<AtomicUsize>) {
    let counter = Arc::new(AtomicUsize::new(0));
    let c = counter.clone();
    let token = ColumnDefault::thunk(move || {
        Val::from(format!("{prefix}-{}", c.fetch_add(1, Ordering::SeqCst) + 1))
    });
    (
        Table::new(name)
            .column(Column::text("id").primary_key())
            .column(Column::text("token").default(token)),
        counter,
    )
}

fn with<'a>(values: &[(&'a str, Val)], key: &'a str, value: &str) -> Vec<(&'a str, Val)> {
    let mut values = values.to_vec();
    match values.iter_mut().find(|(k, _)| *k == key) {
        Some(entry) => entry.1 = Val::from(value),
        None => values.push((key, Val::from(value))),
    }
    values
}

fn val(v: serde_json::Value) -> Val {
    Val::from(v)
}
