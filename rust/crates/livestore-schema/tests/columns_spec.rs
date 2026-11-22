//! Port of `schema/state/sqlite/column-spec.test.ts` (`makeColumnSpec`).

use livestore_schema::column::{Column, ColumnDefault, ColumnKind, ColumnType};
use livestore_schema::table::{Index, Table};
use livestore_schema::value_schema::{self as s, Val};

#[derive(Default)]
struct Opts {
    not_null: bool,
    primary_key: bool,
    auto_increment: bool,
    default_value: Option<ColumnDefault>,
    default_sql: Option<&'static str>,
}

#[test]
fn quotes_column_names_properly_for_reserved_keywords() {
    let table = table(
        "blocks",
        [
            column(
                "order",
                ColumnType::Integer,
                Opts {
                    not_null: true,
                    ..Opts::default()
                },
            ),
            column("group", ColumnType::Text, Opts::default()),
        ],
    );
    let result = table.column_spec();
    assert_eq!(result, r#""order" integer   not null , "group" text    "#);
    assert!(result.contains(r#""order""#));
    assert!(result.contains(r#""group""#));
}

#[test]
fn handles_basic_columns_with_primary_keys() {
    let table = table(
        "users",
        [
            column("id", ColumnType::Text, pk()),
            column("name", ColumnType::Text, Opts::default()),
        ],
    );
    assert_eq!(
        table.column_spec(),
        r#""id" text primary key   , "name" text    "#
    );
}

#[test]
fn handles_multi_column_primary_keys() {
    let table = table(
        "composite",
        [
            column("tenant_id", ColumnType::Text, pk()),
            column("user_id", ColumnType::Text, pk()),
        ],
    );
    let result = table.column_spec();
    assert_eq!(
        result,
        r#""tenant_id" text   not null , "user_id" text   not null , PRIMARY KEY ("tenant_id", "user_id")"#
    );
    assert!(result.contains(r#"PRIMARY KEY ("tenant_id", "user_id")"#));
}

#[test]
fn handles_auto_increment_columns() {
    let table = table(
        "posts",
        [
            column("id", ColumnType::Integer, pk_auto()),
            column("title", ColumnType::Text, Opts::default()),
        ],
    );
    let result = table.column_spec();
    assert_eq!(
        result,
        r#""id" integer primary key autoincrement  , "title" text    "#
    );
    assert!(result.contains("autoincrement"));
    assert!(!result.contains("PRIMARY KEY ('id')"));
}

#[test]
fn handles_columns_with_default_values() {
    let table = table(
        "products",
        [
            column("id", ColumnType::Integer, pk()),
            column(
                "name",
                ColumnType::Text,
                Opts {
                    not_null: true,
                    ..Opts::default()
                },
            ),
            column("price", ColumnType::Real, default(0)),
            column("active", ColumnType::Integer, default(true)),
            column("description", ColumnType::Text, default("No description")),
        ],
    );
    let result = table.column_spec();
    assert_eq!(
        result,
        r#""id" integer primary key   , "name" text   not null , "price" real    default 0, "active" integer    default true, "description" text    default 'No description'"#
    );
    assert!(result.contains("default 0"));
    assert!(result.contains("default true"));
    assert!(result.contains("default 'No description'"));
}

#[test]
fn handles_columns_with_sql_default_values() {
    let table = table(
        "logs",
        [
            column("id", ColumnType::Integer, pk()),
            column("created_at", ColumnType::Text, sql("CURRENT_TIMESTAMP")),
            column("random_value", ColumnType::Real, sql("RANDOM()")),
        ],
    );
    let result = table.column_spec();
    assert_eq!(
        result,
        r#""id" integer primary key   , "created_at" text    default CURRENT_TIMESTAMP, "random_value" real    default RANDOM()"#
    );
    assert!(result.contains("default CURRENT_TIMESTAMP"));
    assert!(result.contains("default RANDOM()"));
}

#[test]
fn omits_default_clause_for_thunk_defaults() {
    let thunk = Opts {
        default_value: Some(ColumnDefault::thunk(|| Val::from("dynamic-token"))),
        ..Opts::default()
    };
    let table = table(
        "thunks",
        [
            column("id", ColumnType::Integer, pk()),
            column("token", ColumnType::Text, thunk),
        ],
    );
    let result = table.column_spec();
    assert_eq!(result, r#""id" integer primary key   , "token" text    "#);
    assert!(!result.contains("dynamic-token"));
    assert!(
        !regex::Regex::new(r#"(?i)token" text\s+default"#)
            .unwrap()
            .is_match(&result)
    );
}

#[test]
fn handles_null_default_values() {
    let table = table(
        "nullable_defaults",
        [
            column("id", ColumnType::Integer, pk()),
            column("optional_text", ColumnType::Text, default(Val::Null)),
        ],
    );
    let result = table.column_spec();
    assert_eq!(
        result,
        r#""id" integer primary key   , "optional_text" text    default null"#
    );
    assert!(result.contains("default null"));
}

#[test]
fn handles_all_column_features_combined() {
    let table = table(
        "complex_table",
        [
            column("id", ColumnType::Integer, pk_auto()),
            column(
                "name",
                ColumnType::Text,
                Opts {
                    not_null: true,
                    ..default("Unnamed")
                },
            ),
            column(
                "created_at",
                ColumnType::Text,
                Opts {
                    not_null: true,
                    ..sql("CURRENT_TIMESTAMP")
                },
            ),
            column("status", ColumnType::Text, default("pending")),
        ],
    );
    assert_eq!(
        table.column_spec(),
        r#""id" integer primary key autoincrement  , "name" text   not null default 'Unnamed', "created_at" text   not null default CURRENT_TIMESTAMP, "status" text    default 'pending'"#
    );
}

#[test]
fn handles_tables_with_indexes() {
    let not_null = || Opts {
        not_null: true,
        ..Opts::default()
    };
    let mut table = table(
        "users_with_indexes",
        [
            column("id", ColumnType::Integer, pk_auto()),
            column("email", ColumnType::Text, not_null()),
            column("username", ColumnType::Text, not_null()),
            column("created_at", ColumnType::Text, sql("CURRENT_TIMESTAMP")),
        ],
    );
    table.indexes = vec![
        index(&["email"], "idx_users_email", true),
        index(&["username"], "idx_users_username", false),
        index(&["created_at"], "idx_users_created_at", false),
    ];
    assert_eq!(
        table.column_spec(),
        r#""id" integer primary key autoincrement  , "email" text   not null , "username" text   not null , "created_at" text    default CURRENT_TIMESTAMP"#
    );
    assert_eq!(table.indexes.len(), 3);
    assert!(table.indexes[0].unique);
    // TS leaves `unique` undefined when not given; Rust's `bool` defaults to false.
    assert!(!table.indexes[1].unique);
}

/// `createColumn`: nullable unless `not_null`; the schema follows the column type like the TS helper.
fn column(name: &str, ty: ColumnType, opts: Opts) -> Column {
    let schema = match ty {
        ColumnType::Text => s::string(),
        ColumnType::Integer
            if matches!(opts.default_value, Some(ColumnDefault::Value(Val::Bool(_)))) =>
        {
            s::boolean()
        }
        ColumnType::Integer | ColumnType::Real => s::finite(),
        ColumnType::Blob => s::uint8array_from_base64(),
    };
    let mut column = Column::new(name, ty, ColumnKind::Text, schema);
    column.nullable = !opts.not_null;
    column.primary_key = opts.primary_key;
    column.auto_increment = opts.auto_increment;
    column.default = opts
        .default_sql
        .map(ColumnDefault::sql)
        .or(opts.default_value);
    column
}

fn table<const N: usize>(name: &str, columns: [Column; N]) -> Table {
    columns.into_iter().fold(Table::new(name), Table::column)
}

fn index(columns: &[&str], name: &str, unique: bool) -> Index {
    Index {
        name: name.into(),
        columns: columns.iter().map(|c| (*c).into()).collect(),
        unique,
    }
}

fn pk() -> Opts {
    Opts {
        not_null: true,
        primary_key: true,
        ..Opts::default()
    }
}

fn pk_auto() -> Opts {
    Opts {
        auto_increment: true,
        ..pk()
    }
}

fn default(value: impl Into<ColumnDefault>) -> Opts {
    Opts {
        default_value: Some(value.into()),
        ..Opts::default()
    }
}

fn sql(sql: &'static str) -> Opts {
    Opts {
        default_sql: Some(sql),
        ..Opts::default()
    }
}
