//! Port of `schema/state/sqlite/db-schema/dsl/field-defs.test.ts`; the vitest snapshots are inlined as
//! `(columnType, default, nullable, primaryKey, autoIncrement, [ast, encodedAst, decodedAst])`.

use livestore_schema::column::{Column, ColumnDefault};
use livestore_schema::value_schema::{self as s, Val};
use serde_json::json;

type Snapshot = (
    &'static str,
    Option<Val>,
    bool,
    bool,
    bool,
    [&'static str; 3],
);

#[test]
fn text() {
    let plain = (
        "text",
        None,
        false,
        false,
        false,
        ["String", "String", "String"],
    );
    assert_eq!(snapshot(&Column::text("")), plain);
    assert_eq!(snapshot(&Column::text("")), plain);
    let nullable = (
        "text",
        Some(Val::Null),
        true,
        false,
        false,
        ["Union", "Union", "Union"],
    );
    assert_eq!(
        snapshot(&Column::text("").default(Val::Null).nullable()),
        nullable
    );
    let foo = (
        "text",
        Some(Val::from("foo")),
        true,
        false,
        false,
        ["Union", "Union", "Union"],
    );
    assert_eq!(
        snapshot(
            &Column::text("")
                .schema(s::literal("foo"))
                .nullable()
                .default("foo")
        ),
        foo
    );
    assert_eq!(
        snapshot(
            &Column::text("")
                .schema(s::union([s::literal("foo")]))
                .nullable()
                .default("foo")
        ),
        foo
    );
}

#[test]
fn json() {
    assert_eq!(
        snapshot(&Column::json("")),
        ("text", None, false, false, false, ["Any", "String", "Any"])
    );
    let union = ["Union", "Union", "Union"];
    assert_eq!(
        snapshot(&Column::json("").default(Val::Null).nullable()),
        ("text", Some(Val::Null), true, false, false, union)
    );
    let bob = Column::json("")
        .schema(s::struct_([("name", s::string())]))
        .default(Val::from(json!({"name": "Bob"})))
        .nullable();
    assert_eq!(
        snapshot(&bob),
        (
            "text",
            Some(Val::from(json!({"name": "Bob"}))),
            true,
            false,
            false,
            union
        )
    );
}

#[test]
fn datetime() {
    let plain = (
        "text",
        None,
        false,
        false,
        false,
        ["Declaration", "String", "Declaration"],
    );
    assert_eq!(snapshot(&Column::datetime("")), plain);
    assert_eq!(snapshot(&Column::datetime("")), plain);
    assert_eq!(
        snapshot(&Column::datetime("").default(Val::Null).nullable()),
        (
            "text",
            Some(Val::Null),
            true,
            false,
            false,
            ["Union", "Union", "Union"]
        )
    );
    let date = Val::Date(1_643_760_000_000.0);
    assert_eq!(
        snapshot(&Column::datetime("").default(date.clone())),
        (
            "text",
            Some(date),
            false,
            false,
            false,
            ["Declaration", "String", "Declaration"]
        )
    );
}

#[test]
fn boolean() {
    let plain = (
        "integer",
        None,
        false,
        false,
        false,
        ["Boolean", "Union", "Boolean"],
    );
    assert_eq!(snapshot(&Column::boolean("")), plain);
    assert_eq!(snapshot(&Column::boolean("")), plain);
    assert_eq!(
        snapshot(&Column::boolean("").default(false)),
        (
            "integer",
            Some(Val::Bool(false)),
            false,
            false,
            false,
            ["Boolean", "Union", "Boolean"]
        )
    );
}

fn snapshot(column: &Column) -> Snapshot {
    let default = column.default.as_ref().map(|d| match d {
        ColumnDefault::Value(v) => v.clone(),
        other => panic!("unexpected default {other:?}"),
    });
    let schema = [
        column.schema.tag(),
        column.schema.to_encoded().tag(),
        column.schema.to_type().tag(),
    ];
    (
        column.ty.as_sql(),
        default,
        column.nullable,
        column.primary_key,
        column.auto_increment,
        schema,
    )
}
