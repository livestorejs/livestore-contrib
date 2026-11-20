//! Port of `schema/state/sqlite/column-annotations.test.ts`. `withColumnType` cannot throw (its
//! compatibility check is a TODO in TS), so "not.toThrow" ports assert the annotation landed.

use std::sync::Arc;

use livestore_schema::column::{
    COLUMN_TYPE, ColumnType, PRIMARY_KEY_ID, with_column_type, with_primary_key,
};
use livestore_schema::value_schema::{self as s, Ast, Val, ValueSchema};

#[test]
fn adds_primary_key_annotation() {
    let result = with_primary_key(&s::string());
    assert!(matches!(result.ast(), Ast::String));
    assert!(result.annotation_bool(PRIMARY_KEY_ID));
}

#[test]
fn string_with_text_column_type() {
    accepts(&s::string(), ColumnType::Text);
}

#[test]
fn number_with_integer_column_type() {
    accepts(&s::finite(), ColumnType::Integer);
}

#[test]
fn number_with_real_column_type() {
    accepts(&s::finite(), ColumnType::Real);
}

#[test]
fn boolean_with_integer_column_type() {
    accepts(&s::boolean(), ColumnType::Integer);
}

#[test]
fn uint8array_with_blob_column_type() {
    accepts(&s::uint8array(), ColumnType::Blob);
}

#[test]
fn date_with_text_column_type() {
    accepts(&s::date(), ColumnType::Text);
}

#[test]
fn string_literal_with_text_column_type() {
    accepts(&s::literal("hello"), ColumnType::Text);
}

#[test]
fn number_literal_with_integer_column_type() {
    accepts(&s::literal(42), ColumnType::Integer);
}

#[test]
#[allow(clippy::approx_constant)]
fn number_literal_with_real_column_type() {
    accepts(&s::literal(3.14), ColumnType::Real);
}

#[test]
fn boolean_literal_with_integer_column_type() {
    accepts(&s::literal(true), ColumnType::Integer);
}

#[test]
fn union_of_same_type_with_compatible_column_type() {
    accepts(&s::literals(["a", "b"]), ColumnType::Text);
}

#[test]
fn transformation_schema_with_compatible_base_type() {
    let transform = s::string().decode_from(
        &s::string(),
        Arc::new(|v| Ok(Val::from(v.js_to_string().to_uppercase()))),
        Arc::new(|v| Ok(Val::from(v.js_to_string().to_lowercase()))),
    );
    accepts(&transform, ColumnType::Text);
}

#[test]
fn allows_complex_schemas_that_cannot_be_determined() {
    accepts(
        &s::struct_([("name", s::string()), ("age", s::finite())]),
        ColumnType::Text,
    );
}

#[test]
fn allows_any_with_any_column_type() {
    for ty in [
        ColumnType::Text,
        ColumnType::Integer,
        ColumnType::Real,
        ColumnType::Blob,
    ] {
        accepts(&s::any(), ty);
    }
}

#[test]
fn allows_unknown_with_any_column_type() {
    for ty in [
        ColumnType::Text,
        ColumnType::Integer,
        ColumnType::Real,
        ColumnType::Blob,
    ] {
        accepts(&s::unknown(), ty);
    }
}

#[test]
fn adds_column_type_annotation_to_schema() {
    let result = with_column_type(&s::string(), ColumnType::Text);
    assert!(matches!(result.ast(), Ast::String));
    assert_eq!(result.annotation_str(COLUMN_TYPE), Some("text"));
}

#[test]
fn preserves_existing_annotations() {
    let result = with_column_type(&with_primary_key(&s::string()), ColumnType::Text);
    assert!(matches!(result.ast(), Ast::String));
    assert_eq!(result.annotation_str(COLUMN_TYPE), Some("text"));
    assert!(result.annotation_bool(PRIMARY_KEY_ID));
}

fn accepts(schema: &ValueSchema, ty: ColumnType) {
    assert_eq!(
        with_column_type(schema, ty).annotation_str(COLUMN_TYPE),
        Some(ty.as_sql())
    );
}
