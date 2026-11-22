//! Port of `schema/state/sqlite/column-def.test.ts` (`getColumnDefForSchema` and schema-based tables).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use livestore_schema::column::{
    ColumnDefault, ColumnType, get_column_def_for_schema, with_auto_increment, with_column_type,
    with_default, with_primary_key, with_unique,
};
use livestore_schema::table::{Index, Table};
use livestore_schema::value_schema::{
    self as s, Annotation, DATE_REPRESENTATION, UINT8ARRAY_REPRESENTATION, Val, ValueSchema,
};
use serde_json::json;

const ISO: &str = "2026-01-02T03:04:05.678Z";
const MS: f64 = 1_767_323_045_678.0;

#[test]
fn maps_string_to_text_column() {
    assert_eq!(get_column_def_for_schema(&s::string()).ty, ColumnType::Text);
}

#[test]
fn maps_number_to_real_column() {
    assert_eq!(get_column_def_for_schema(&s::finite()).ty, ColumnType::Real);
}

#[test]
fn maps_boolean_to_integer_column() {
    assert_eq!(
        get_column_def_for_schema(&s::boolean()).ty,
        ColumnType::Integer
    );
}

#[test]
fn maps_date_to_text_column() {
    let column = get_column_def_for_schema(&s::date());
    assert_eq!(column.ty, ColumnType::Text);
    assert_eq!(column.schema.encode(Val::Date(MS)), Ok(Val::from(ISO)));
    assert_eq!(column.schema.decode(Val::from(ISO)), Ok(Val::Date(MS)));
    assert_eq!(column.schema.to_encoded().tag(), "String");
    assert_eq!(
        column.schema.to_type().representation(),
        Some(DATE_REPRESENTATION)
    );
}

#[test]
fn maps_date_from_millis_to_integer_column() {
    let column = get_column_def_for_schema(&s::date_from_millis());
    assert_eq!(column.ty, ColumnType::Integer);
    assert_eq!(column.schema.to_encoded().tag(), "Number");
    assert_eq!(
        column.schema.to_type().representation(),
        Some(DATE_REPRESENTATION)
    );
}

#[test]
fn preserves_date_representation_through_checks() {
    let schema = s::date_from_millis().check(s::is_greater_than_date(0.0));
    assert_eq!(get_column_def_for_schema(&schema).ty, ColumnType::Integer);
}

#[test]
fn preserves_bare_date_checks_on_encoding_and_decoding() {
    let column = get_column_def_for_schema(&s::date().check(s::is_greater_than_date(0.0)));
    assert_eq!(column.schema.encode(Val::Date(MS)), Ok(Val::from(ISO)));
    assert_eq!(column.schema.decode(Val::from(ISO)), Ok(Val::Date(MS)));
    assert!(column.schema.encode(Val::Date(0.0)).is_err());
    assert!(
        column
            .schema
            .decode(Val::from("1970-01-01T00:00:00.000Z"))
            .is_err()
    );
}

#[test]
fn round_trips_transformations_with_an_encoded_date() {
    let column = get_column_def_for_schema(&iso_string_from_date());
    assert_eq!(column.ty, ColumnType::Text);
    assert_eq!(column.schema.encode(Val::from(ISO)), Ok(Val::from(ISO)));
    assert_eq!(column.schema.decode(Val::from(ISO)), Ok(Val::from(ISO)));
}

#[test]
fn round_trips_nullable_transformations_with_an_encoded_date() {
    check_round_trip_wrapped(s::null_or(iso_string_from_date()));
}

#[test]
fn round_trips_optional_transformations_with_an_encoded_date() {
    check_round_trip_wrapped(s::optional(iso_string_from_date()));
}

#[test]
fn round_trips_transformations_with_an_encoded_nullable_date() {
    let schema = s::string().decode_from(
        &s::null_or(s::date()),
        Arc::new(|v| {
            Ok(if v == Val::Null {
                Val::from("none")
            } else {
                Val::from(v.js_to_string())
            })
        }),
        Arc::new(|v| {
            Ok(if v == Val::from("none") {
                Val::Null
            } else {
                parse_date(&v)
            })
        }),
    );
    let table =
        Table::from_schema(Some("stamps"), &s::struct_([("value", schema)]), vec![]).unwrap();
    let column = table.col("value");
    let encoded = column.schema.encode(Val::from(ISO)).unwrap();
    assert_eq!(column.schema.decode(encoded.clone()), Ok(Val::from(ISO)));
    assert_eq!(encoded, Val::from(ISO));
    assert!(column.nullable);
    assert_eq!(column.schema.encode(Val::from("none")), Ok(Val::Null));
    assert_eq!(column.schema.decode(Val::Null), Ok(Val::from("none")));
}

#[test]
fn maps_bigint_to_text_column() {
    assert_eq!(get_column_def_for_schema(&s::bigint()).ty, ColumnType::Text);
}

#[test]
fn maps_int_to_integer_column() {
    assert_eq!(get_column_def_for_schema(&s::int()).ty, ColumnType::Integer);
    assert_eq!(
        get_column_def_for_schema(&s::int().check(s::is_greater_than_or_equal_to(1.0))).ty,
        ColumnType::Integer
    );
}

#[test]
fn maps_string_refinements_to_text_column() {
    let refinements = [
        (s::non_empty_string(), "NonEmptyString"),
        (s::trim(), "Trim"),
        (s::string().check(s::is_uuid()), "UUID"),
        (s::string().check(s::is_ulid()), "ULID"),
        (s::string().check(s::is_min_length(5)), "minLength"),
        (
            s::string().check(s::is_pattern("^[A-Z]+$").expect("valid pattern")),
            "pattern",
        ),
    ];
    for (schema, name) in refinements {
        assert_eq!(
            get_column_def_for_schema(&schema).ty,
            ColumnType::Text,
            "{name} should map to text"
        );
    }
}

#[test]
fn maps_number_refinements_to_real_column() {
    for (schema, name) in [
        (s::finite(), "Finite"),
        (s::finite().check(s::is_between(0.0, 100.0)), "between"),
    ] {
        assert_eq!(
            get_column_def_for_schema(&schema).ty,
            ColumnType::Real,
            "{name} should map to real"
        );
    }
}

#[test]
fn maps_string_literals_to_text_column() {
    assert_eq!(
        get_column_def_for_schema(&s::literal("active")).ty,
        ColumnType::Text
    );
}

#[test]
fn maps_number_literals_to_real_column() {
    assert_eq!(
        get_column_def_for_schema(&s::literal(42)).ty,
        ColumnType::Real
    );
}

#[test]
fn maps_boolean_literals_to_integer_column() {
    assert_eq!(
        get_column_def_for_schema(&s::literal(true)).ty,
        ColumnType::Integer
    );
}

#[test]
fn maps_transformations_based_on_target_type() {
    assert_eq!(
        get_column_def_for_schema(&s::finite_from_string()).ty,
        ColumnType::Text
    );
}

#[test]
fn handles_date_transformations() {
    assert_eq!(get_column_def_for_schema(&s::date()).ty, ColumnType::Text);
}

#[test]
fn maps_structs_to_json_column() {
    let user = s::struct_([("name", s::string()), ("age", s::finite())]);
    assert_eq!(get_column_def_for_schema(&user).ty, ColumnType::Text);
}

#[test]
fn maps_arrays_to_json_column() {
    assert_eq!(
        get_column_def_for_schema(&s::array(s::string())).ty,
        ColumnType::Text
    );
}

#[test]
fn maps_records_to_json_column() {
    assert_eq!(
        get_column_def_for_schema(&s::record(s::finite())).ty,
        ColumnType::Text
    );
}

#[test]
fn maps_tuples_to_json_column() {
    assert_eq!(
        get_column_def_for_schema(&s::tuple([s::string(), s::finite()])).ty,
        ColumnType::Text
    );
}

#[test]
fn maps_tagged_unions_to_json_column() {
    let result = s::union([
        s::tagged_struct("success", [("value", s::string())]),
        s::tagged_struct("error", [("error", s::string())]),
    ]);
    assert_eq!(get_column_def_for_schema(&result).ty, ColumnType::Text);
}

#[test]
fn handles_deeply_nested_schemas() {
    let nested = s::struct_([(
        "level1",
        s::struct_([("level2", s::struct_([("value", s::string())]))]),
    )]);
    assert_eq!(get_column_def_for_schema(&nested).ty, ColumnType::Text);
}

#[test]
fn handles_optional_nested_schemas() {
    let schema = s::union([s::struct_([("name", s::string())]), s::undefined()]);
    assert_eq!(get_column_def_for_schema(&schema).ty, ColumnType::Text);
}

#[test]
fn defaults_to_json_column_for_unhandled_types() {
    let edge_cases = [
        (s::unknown(), "Unknown"),
        (s::any(), "Any"),
        (s::null(), "Null"),
        (s::undefined(), "Undefined"),
        (s::void(), "Void"),
    ];
    for (schema, name) in edge_cases {
        assert_eq!(
            get_column_def_for_schema(&schema).ty,
            ColumnType::Text,
            "{name} should map to text (JSON storage)"
        );
    }
}

#[test]
fn handles_never_schema() {
    let never = s::string().check(s::make_filter("Always fails", |_| false));
    assert_eq!(get_column_def_for_schema(&never).ty, ColumnType::Text);
}

#[test]
fn handles_symbol_schema() {
    assert_eq!(get_column_def_for_schema(&s::symbol()).ty, ColumnType::Text);
}

#[test]
fn handles_schema_extend() {
    let base = s::struct_([("id", s::string()), ("createdAt", s::date())]);
    let extended = s::struct_(base.fields().into_iter().chain([
        ("name".into(), s::string()),
        ("updatedAt".into(), s::date()),
    ]));
    assert_eq!(get_column_def_for_schema(&extended).ty, ColumnType::Text);
}

#[test]
fn handles_schema_pick() {
    let user = s::struct_([
        ("id", s::string()),
        ("name", s::string()),
        ("email", s::string()),
    ]);
    let picked = s::struct_(
        user.fields()
            .into_iter()
            .filter(|(k, _)| k == "id" || k == "name"),
    );
    assert_eq!(get_column_def_for_schema(&picked).ty, ColumnType::Text);
}

#[test]
fn handles_schema_omit() {
    let user = s::struct_([
        ("id", s::string()),
        ("name", s::string()),
        ("password", s::string()),
    ]);
    let public = s::struct_(user.fields().into_iter().filter(|(k, _)| k != "password"));
    assert_eq!(get_column_def_for_schema(&public).ty, ColumnType::Text);
}

#[test]
fn handles_schemas_with_custom_annotations() {
    let annotated_string =
        s::string().annotate("description", Annotation::Str("A special string".into()));
    let annotated_number = s::finite()
        .annotate("min", Annotation::Json(json!(0)))
        .annotate("max", Annotation::Json(json!(100)));
    assert_eq!(
        get_column_def_for_schema(&annotated_string).ty,
        ColumnType::Text
    );
    assert_eq!(
        get_column_def_for_schema(&annotated_number).ty,
        ColumnType::Real
    );
}

#[test]
fn handles_enums_and_literal_unions_as_text() {
    let status_enum = s::enums([
        ("PENDING", "pending"),
        ("ACTIVE", "active"),
        ("INACTIVE", "inactive"),
    ]);
    let status_union = s::literals(["pending", "active", "inactive"]);
    assert_eq!(get_column_def_for_schema(&status_enum).ty, ColumnType::Text);
    assert_eq!(
        get_column_def_for_schema(&status_union).ty,
        ColumnType::Text
    );
}

#[test]
fn handles_unions_of_numeric_literals_as_integer_column() {
    assert_eq!(
        get_column_def_for_schema(&s::literals([1, 5, 15, 30])).ty,
        ColumnType::Integer
    );
}

#[test]
fn handles_unions_of_non_integer_numeric_literals_as_real_column() {
    assert_eq!(
        get_column_def_for_schema(&s::literals([0.1, 0.2, 0.25])).ty,
        ColumnType::Real
    );
}

#[test]
fn handles_uint8array_as_blob_column() {
    let column = get_column_def_for_schema(&s::uint8array());
    assert_eq!(column.ty, ColumnType::Blob);
    assert_eq!(
        column.schema.to_type().representation(),
        Some(UINT8ARRAY_REPRESENTATION)
    );
    assert_eq!(
        column.schema.decode(Val::Bytes(vec![1, 2, 3])),
        Ok(Val::Bytes(vec![1, 2, 3]))
    );
}

#[test]
fn preserves_uint8array_checks_on_blob_columns() {
    let schema = s::uint8array().check(s::make_filter(
        "non-empty",
        |v| matches!(v, Val::Bytes(b) if !b.is_empty()),
    ));
    let column = get_column_def_for_schema(&schema);
    assert_eq!(column.ty, ColumnType::Blob);
    assert!(column.schema.same(&schema));
    assert_eq!(
        column.schema.decode(Val::Bytes(vec![1])),
        Ok(Val::Bytes(vec![1]))
    );
    assert!(column.schema.decode(Val::Bytes(vec![])).is_err());
}

#[test]
fn handles_recursive_schemas_as_json() {
    fn tree_node() -> ValueSchema {
        s::struct_([
            ("value", s::string()),
            ("children", s::array(s::suspend(tree_node))),
        ])
    }
    assert_eq!(get_column_def_for_schema(&tree_node()).ty, ColumnType::Text);
}

#[test]
fn handles_optional_fields_in_schema_based_tables() {
    let user = s::struct_([
        ("id", s::string()),
        ("name", s::string()),
        ("email", s::optional(s::string())),
        ("age", s::optional(s::finite())),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert!(table.col("email").nullable);
    assert!(table.col("age").nullable);
    assert!(!table.col("id").nullable);
    assert!(!table.col("name").nullable);
    let row = val(json!({"id": "user-1", "name": "Ada", "email": null, "age": null}));
    assert_eq!(table.row_schema().decode(row.clone()), Ok(row));
}

#[test]
fn handles_optional_boolean_with_proper_transformation() {
    let table = Table::from_schema(
        Some("test"),
        &s::struct_([("id", s::string()), ("active", s::optional(s::boolean()))]),
        vec![],
    )
    .unwrap();
    assert!(table.col("active").nullable);
    assert_eq!(table.col("active").ty, ColumnType::Integer);
    assert_eq!(
        table
            .row_schema()
            .decode(val(json!({"id": "row-1", "active": 1}))),
        Ok(val(json!({"id": "row-1", "active": true})))
    );
    assert_eq!(
        table.col("active").schema.encode(Val::Bool(false)),
        Ok(Val::Number(0.0))
    );
    let null_row = val(json!({"id": "row-1", "active": null}));
    assert_eq!(table.row_schema().decode(null_row.clone()), Ok(null_row));
}

#[test]
fn handles_optional_complex_types_with_json_encoding() {
    let schema = s::struct_([
        ("id", s::string()),
        (
            "metadata",
            s::optional(s::struct_([("color", s::string())])),
        ),
        ("tags", s::optional(s::array(s::string()))),
    ]);
    let table = Table::from_schema(Some("test"), &schema, vec![]).unwrap();
    for name in ["metadata", "tags"] {
        assert!(table.col(name).nullable);
        assert_eq!(table.col(name).ty, ColumnType::Text);
    }
    let encoded = val(
        json!({"id": "row-1", "metadata": r#"{"color":"red"}"#, "tags": r#"["urgent","local"]"#}),
    );
    let decoded =
        val(json!({"id": "row-1", "metadata": {"color": "red"}, "tags": ["urgent", "local"]}));
    assert_eq!(table.row_schema().decode(encoded), Ok(decoded));
    let nulls = val(json!({"id": "row-1", "metadata": null, "tags": null}));
    assert_eq!(table.row_schema().decode(nulls.clone()), Ok(nulls));
}

#[test]
fn handles_schema_null_or() {
    let schema = s::struct_([
        ("id", s::string()),
        ("description", s::null_or(s::string())),
        ("count", s::null_or(s::int())),
    ]);
    let table = Table::from_schema(Some("test"), &schema, vec![]).unwrap();
    assert!(table.col("description").nullable);
    assert!(table.col("count").nullable);
    for row in [
        json!({"id": "row-1", "description": "ready", "count": 1}),
        json!({"id": "row-1", "description": null, "count": null}),
    ] {
        assert_eq!(table.row_schema().decode(val(row.clone())), Ok(val(row)));
    }
}

#[test]
fn treats_unions_of_string_literals_as_text_columns_without_json_parsing() {
    let schema = s::struct_([
        ("id", s::string()),
        ("status", s::literals(["idle", "running", "stopped"])),
    ]);
    let table = Table::from_schema(Some("timers"), &schema, vec![]).unwrap();
    assert_eq!(table.col("status").ty, ColumnType::Text);
    assert_eq!(table.col("status").schema.to_encoded().tag(), "Union");
    let row = val(json!({"id": "timer-1", "status": "idle"}));
    assert_eq!(table.row_schema().decode(row.clone()), Ok(row));
}

#[test]
fn handles_schema_null_or_with_complex_types() {
    let schema =
        s::struct_([("data", s::null_or(s::struct_([("value", s::finite())])))]).title("test");
    let table = Table::from_schema(None, &schema, vec![]).unwrap();
    assert!(table.col("data").nullable);
    assert_eq!(table.col("data").ty, ColumnType::Text);
    assert_eq!(
        table
            .row_schema()
            .decode(val(json!({"data": r#"{"value":42}"#}))),
        Ok(val(json!({"data": {"value": 42}})))
    );
    assert_eq!(
        table.row_schema().decode(val(json!({"data": null}))),
        Ok(val(json!({"data": null})))
    );
}

#[test]
fn handles_mixed_nullable_and_optional_fields() {
    let schema = s::struct_([
        ("nullableText", s::null_or(s::string())),
        ("optionalText", s::optional(s::string())),
        (
            "optionalJson",
            s::optional(s::struct_([("x", s::finite())])),
        ),
    ])
    .title("test");
    let table = Table::from_schema(None, &schema, vec![]).unwrap();
    for name in ["nullableText", "optionalText", "optionalJson"] {
        assert!(table.col(name).nullable);
    }
    let decode = |name: &str, v: Val| table.col(name).schema.decode(v);
    assert_eq!(
        decode("nullableText", Val::from("hello")),
        Ok(Val::from("hello"))
    );
    assert_eq!(decode("nullableText", Val::Null), Ok(Val::Null));
    assert_eq!(decode("optionalText", Val::Null), Ok(Val::Null));
    assert_eq!(
        decode("optionalJson", Val::from(r#"{"x":1}"#)),
        Ok(val(json!({"x": 1})))
    );
    assert_eq!(decode("optionalJson", Val::Null), Ok(Val::Null));
}

#[test]
fn respects_column_type_annotation_for_text() {
    assert_eq!(
        get_column_def_for_schema(&with_column_type(&s::finite(), ColumnType::Text)).ty,
        ColumnType::Text
    );
}

#[test]
fn respects_column_type_annotation_for_integer() {
    assert_eq!(
        get_column_def_for_schema(&with_column_type(&s::string(), ColumnType::Integer)).ty,
        ColumnType::Integer
    );
}

#[test]
fn respects_column_type_annotation_for_real() {
    assert_eq!(
        get_column_def_for_schema(&with_column_type(&s::boolean(), ColumnType::Real)).ty,
        ColumnType::Real
    );
}

#[test]
fn respects_column_type_annotation_for_blob() {
    assert_eq!(
        get_column_def_for_schema(&with_column_type(&s::string(), ColumnType::Blob)).ty,
        ColumnType::Blob
    );
}

#[test]
fn column_type_annotation_overrides_default_type_mapping() {
    assert_eq!(
        get_column_def_for_schema(&with_column_type(&s::finite(), ColumnType::Text)).ty,
        ColumnType::Text
    );
}

/// TS `withColumnType(schema, t)` and `schema.pipe(withColumnType(t))` are one Rust function.
#[test]
fn with_column_type_dual_api() {
    let schema1 = with_column_type(&s::string(), ColumnType::Integer);
    let schema2 = s::string().pipe(|x| with_column_type(x, ColumnType::Integer));
    assert_eq!(get_column_def_for_schema(&schema1).ty, ColumnType::Integer);
    assert_eq!(get_column_def_for_schema(&schema2).ty, ColumnType::Integer);
}

#[test]
fn adds_primary_key_annotation_to_schema() {
    let user = s::struct_([
        ("id", with_primary_key(&s::string())),
        ("name", s::string()),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert!(table.col("id").primary_key);
    assert!(!table.col("id").nullable);
    assert!(!table.col("name").primary_key);
    assert!(!table.col("name").nullable);
}

#[test]
fn throws_when_primary_key_is_used_with_optional_schema() {
    let optional_string = s::union([s::string(), s::undefined()]);
    let user = s::struct_([
        ("id", with_primary_key(&optional_string)),
        ("name", s::string()),
    ]);
    let err = Table::from_schema(Some("users"), &user, vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Primary key columns cannot be nullable");
}

#[test]
fn throws_when_primary_key_is_used_with_null_or_schema() {
    let user = s::struct_([
        ("id", with_primary_key(&s::null_or(s::string()))),
        ("name", s::string()),
    ]);
    let err = Table::from_schema(Some("users"), &user, vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Primary key columns cannot be nullable");
}

#[test]
fn primary_key_works_with_column_type_annotation() {
    let user = s::struct_([
        (
            "id",
            with_primary_key(&with_column_type(&s::finite(), ColumnType::Integer)),
        ),
        ("name", s::string()),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert_eq!(table.col("id").ty, ColumnType::Integer);
    assert!(table.col("id").primary_key);
}

#[test]
fn primary_key_works_with_schema_int() {
    let user = s::struct_([("id", with_primary_key(&s::int())), ("name", s::string())]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert_eq!(table.col("id").ty, ColumnType::Integer);
    assert!(table.col("id").primary_key);
}

#[test]
fn adds_auto_increment_annotation_to_schema() {
    let user = s::struct_([
        ("id", with_auto_increment(&with_primary_key(&s::int()))),
        ("name", s::string()),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert!(table.col("id").auto_increment);
    assert!(table.col("id").primary_key);
    assert_eq!(table.col("id").ty, ColumnType::Integer);
}

#[test]
fn adds_default_value_annotation_to_schema() {
    let user = s::struct_([
        ("id", s::string()),
        ("active", with_default(&s::boolean(), true)),
        ("createdAt", with_default(&s::string(), "CURRENT_TIMESTAMP")),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert!(matches!(
        &table.col("active").default,
        Some(ColumnDefault::Value(Val::Bool(true)))
    ));
    assert!(
        matches!(&table.col("createdAt").default, Some(ColumnDefault::Value(Val::String(v))) if v == "CURRENT_TIMESTAMP")
    );
}

/// TS `withDefault(schema, v)` and `schema.pipe(withDefault(v))` are one Rust function.
#[test]
fn with_default_dual_api() {
    let schema1 = with_default(&s::int(), 0);
    let schema2 = s::int().pipe(|x| with_default(x, 0));
    let table1 = Table::from_schema(Some("t1"), &s::struct_([("count", schema1)]), vec![]).unwrap();
    let table2 = Table::from_schema(Some("t2"), &s::struct_([("count", schema2)]), vec![]).unwrap();
    for table in [table1, table2] {
        assert!(
            matches!(&table.col("count").default, Some(ColumnDefault::Value(Val::Number(n))) if *n == 0.0)
        );
    }
}

#[test]
fn supports_thunk_defaults_without_eager_evaluation() {
    let counter = Arc::new(AtomicUsize::new(0));
    let c = counter.clone();
    let thunk = ColumnDefault::thunk(move || {
        Val::from(format!("user-{}", c.fetch_add(1, Ordering::SeqCst) + 1))
    });
    let user = s::struct_([("id", with_default(&s::string(), thunk))]);
    let table = Table::from_schema(Some("users_with_thunk"), &user, vec![]).unwrap();
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    let Some(default @ ColumnDefault::Thunk(_)) = &table.col("id").default else {
        panic!("expected a thunk default")
    };
    assert_eq!(default.resolve(), Some(Val::from("user-1")));
    assert_eq!(default.resolve(), Some(Val::from("user-2")));
}

#[test]
fn creates_unique_index_for_column_with_unique_annotation() {
    let user = s::struct_([
        ("id", s::string()),
        ("email", with_unique(&s::string())),
        ("username", with_unique(&s::string())),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    let unique: Vec<&Index> = table.indexes.iter().filter(|i| i.unique).collect();
    assert_eq!(unique.len(), 2);
    assert!(
        unique
            .iter()
            .any(|i| i.name == "idx_users_email_unique" && i.columns.contains(&"email".into()))
    );
    assert!(
        unique.iter().any(
            |i| i.name == "idx_users_username_unique" && i.columns.contains(&"username".into())
        )
    );
}

#[test]
fn combines_unique_indexes_with_user_provided_indexes() {
    let user = s::struct_([("id", s::string()), ("email", with_unique(&s::string()))]);
    let custom = Index {
        name: "idx_custom".into(),
        columns: vec!["id".into(), "email".into()],
        unique: false,
    };
    let table = Table::from_schema(Some("users"), &user, vec![custom]).unwrap();
    assert_eq!(table.indexes.len(), 2);
    assert!(table.indexes.iter().any(|i| i.name == "idx_custom"));
    assert!(
        table
            .indexes
            .iter()
            .any(|i| i.name == "idx_users_email_unique")
    );
}

#[test]
fn works_with_multiple_annotations() {
    let id = with_primary_key(&with_column_type(
        &s::uint8array_from_base64(),
        ColumnType::Blob,
    ));
    let table = Table::from_schema(
        Some("users"),
        &s::struct_([("id", id), ("name", s::string())]),
        vec![],
    )
    .unwrap();
    assert_eq!(table.col("id").ty, ColumnType::Blob);
    assert!(table.col("id").primary_key);
}

#[test]
fn combines_all_annotations() {
    let user = s::struct_([
        ("id", with_auto_increment(&with_primary_key(&s::int()))),
        ("email", with_unique(&s::string())),
        ("status", with_default(&s::string(), "active")),
        (
            "metadata",
            with_column_type(&s::unknown(), ColumnType::Text),
        ),
    ]);
    let table = Table::from_schema(Some("users"), &user, vec![]).unwrap();
    assert!(table.col("id").primary_key);
    assert!(table.col("id").auto_increment);
    assert_eq!(table.col("id").ty, ColumnType::Integer);
    assert_eq!(table.col("email").ty, ColumnType::Text);
    assert!(
        table
            .indexes
            .iter()
            .any(|i| i.name == "idx_users_email_unique" && i.unique)
    );
    assert!(
        matches!(&table.col("status").default, Some(ColumnDefault::Value(Val::String(v))) if v == "active")
    );
    assert_eq!(table.col("metadata").ty, ColumnType::Text);
}

fn check_round_trip_wrapped(field: ValueSchema) {
    let table =
        Table::from_schema(Some("stamps"), &s::struct_([("value", field)]), vec![]).unwrap();
    let column = table.col("value");
    assert!(column.nullable);
    assert_eq!(column.ty, ColumnType::Text);
    let encoded = column.schema.encode(Val::from(ISO)).unwrap();
    assert_eq!(column.schema.decode(encoded.clone()), Ok(Val::from(ISO)));
    assert_eq!(encoded, Val::from(ISO));
    assert_eq!(column.schema.encode(Val::Null), Ok(Val::Null));
    assert_eq!(column.schema.decode(Val::Null), Ok(Val::Null));
}

/// `Schema.Date.pipe(Schema.decodeTo(Schema.String, { decode: toISOString, encode: new Date }))`.
fn iso_string_from_date() -> ValueSchema {
    s::string().decode_from(
        &s::date(),
        Arc::new(|v| Ok(Val::from(v.js_to_string()))),
        Arc::new(|v| Ok(parse_date(&v))),
    )
}

fn parse_date(v: &Val) -> Val {
    s::date_from_string()
        .decode(v.clone())
        .unwrap_or(Val::Date(f64::NAN))
}

fn val(v: serde_json::Value) -> Val {
    Val::from(v)
}
