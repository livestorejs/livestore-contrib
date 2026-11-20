//! Column definitions: the field-def DSL (`db-schema/dsl/field-defs.ts`), column annotations
//! (`column-annotations.ts`) and schema-derived columns (`column-def.ts`).

use std::fmt;
use std::sync::Arc;

use crate::value_schema::{
    self as s, Annotation, Ast, DATE_REPRESENTATION, IS_INT, UINT8ARRAY_REPRESENTATION, Val,
    ValueSchema,
};

pub const PRIMARY_KEY_ID: &str = "livestore/state/sqlite/annotations/primary-key";
pub const COLUMN_TYPE: &str = "livestore/state/sqlite/annotations/column-type";
pub const DEFAULT: &str = "livestore/state/sqlite/annotations/default";
pub const AUTO_INCREMENT: &str = "livestore/state/sqlite/annotations/auto-increment";
pub const UNIQUE: &str = "livestore/state/sqlite/annotations/unique";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnType {
    Text,
    Integer,
    Real,
    Blob,
}

/// Coarse codec family of a column, for consumers that branch on it (the source of truth is `schema`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnKind {
    Text,
    Integer,
    Real,
    Blob,
    Boolean,
    /// `datetime()`: ISO string in a text column.
    Datetime,
    /// `datetimeInteger()`: epoch millis in an integer column.
    DatetimeMillis,
    Json,
}

/// `ColumnDefaultValue`: a decoded value, a thunk evaluated per use, or a raw SQL expression.
#[derive(Clone)]
pub enum ColumnDefault {
    Value(Val),
    Thunk(Arc<dyn Fn() -> Val + Send + Sync>),
    Sql(String),
}

#[derive(Clone, Debug)]
pub struct Column {
    pub name: String,
    pub ty: ColumnType,
    pub kind: ColumnKind,
    /// Codec between the decoded value and what SQLite stores (`NullOr`-wrapped when nullable).
    pub schema: ValueSchema,
    pub default: Option<ColumnDefault>,
    pub nullable: bool,
    pub primary_key: bool,
    pub auto_increment: bool,
    /// Overrides the `SchemaRepresentation` document derived from `schema`, for Effect schemas the DSL cannot
    /// express (recursive or opaque declarations).
    pub schema_repr: Option<serde_json::Value>,
    base: ValueSchema,
    wrap_custom: fn(ValueSchema) -> ValueSchema,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TableDefError(pub String);

impl ColumnType {
    pub fn as_sql(self) -> &'static str {
        match self {
            ColumnType::Text => "text",
            ColumnType::Integer => "integer",
            ColumnType::Real => "real",
            ColumnType::Blob => "blob",
        }
    }
}

impl ColumnDefault {
    pub fn sql(sql: &str) -> Self {
        Self::Sql(sql.into())
    }

    pub fn thunk(f: impl Fn() -> Val + Send + Sync + 'static) -> Self {
        Self::Thunk(Arc::new(f))
    }

    /// `resolveColumnDefault`: evaluates thunks; `None` for SQL defaults.
    pub fn resolve(&self) -> Option<Val> {
        match self {
            Self::Value(v) => Some(v.clone()),
            Self::Thunk(f) => Some(f()),
            Self::Sql(_) => None,
        }
    }
}

impl Column {
    /// `SqliteDsl.column(type)` with that type's default schema.
    pub fn new(name: &str, ty: ColumnType, kind: ColumnKind, base: ValueSchema) -> Self {
        Self {
            name: name.into(),
            ty,
            kind,
            schema: base.clone(),
            default: None,
            nullable: false,
            primary_key: false,
            auto_increment: false,
            schema_repr: None,
            base,
            wrap_custom: |schema| schema,
        }
    }

    pub fn text(name: &str) -> Self {
        Self::new(name, ColumnType::Text, ColumnKind::Text, s::string())
    }

    pub fn integer(name: &str) -> Self {
        Self::new(name, ColumnType::Integer, ColumnKind::Integer, s::finite())
    }

    /// `real()` defaults to `SqliteReal` (Infinity/NaN allowed).
    pub fn real(name: &str) -> Self {
        Self::new(name, ColumnType::Real, ColumnKind::Real, s::number())
    }

    pub fn blob(name: &str) -> Self {
        Self::new(name, ColumnType::Blob, ColumnKind::Blob, s::uint8array())
    }

    pub fn boolean(name: &str) -> Self {
        Self::new(
            name,
            ColumnType::Integer,
            ColumnKind::Boolean,
            s::boolean_from_bit(),
        )
    }

    /// `datetime()`: ISO string in a text column.
    pub fn datetime(name: &str) -> Self {
        Self::new(
            name,
            ColumnType::Text,
            ColumnKind::Datetime,
            s::date_from_string(),
        )
    }

    /// `datetimeInteger()`: epoch millis in an integer column.
    pub fn datetime_millis(name: &str) -> Self {
        Self::new(
            name,
            ColumnType::Integer,
            ColumnKind::DatetimeMillis,
            s::date_from_millis(),
        )
    }

    /// `json({ schema })`; the custom schema is wrapped in `fromJsonString`.
    pub fn json(name: &str) -> Self {
        Self {
            wrap_custom: s::from_json_string,
            ..Self::new(
                name,
                ColumnType::Text,
                ColumnKind::Json,
                s::from_json_string(s::any()),
            )
        }
    }

    pub fn schema(mut self, schema: ValueSchema) -> Self {
        self.base = (self.wrap_custom)(schema);
        self.rebuild_schema()
    }

    pub fn schema_repr(mut self, repr: serde_json::Value) -> Self {
        self.schema_repr = Some(repr);
        self
    }

    pub fn primary_key(mut self) -> Self {
        self.primary_key = true;
        self
    }

    pub fn auto_increment(mut self) -> Self {
        self.auto_increment = true;
        self
    }

    pub fn nullable(mut self) -> Self {
        self.nullable = true;
        self.rebuild_schema()
    }

    pub fn default(mut self, value: impl Into<ColumnDefault>) -> Self {
        self.default = Some(value.into());
        self
    }

    pub fn named(mut self, name: &str) -> Self {
        self.name = name.into();
        self
    }

    /// `toSqliteColumnSpec`: `"name" type [primary key] [autoincrement] [not null] [default ...]`.
    pub(crate) fn spec(&self, inline_primary_key: bool) -> String {
        let nullable = if inline_primary_key || self.nullable {
            ""
        } else {
            "not null"
        };
        let pk = if inline_primary_key {
            "primary key"
        } else {
            ""
        };
        let auto = if inline_primary_key && self.ty == ColumnType::Integer && self.auto_increment {
            "autoincrement"
        } else {
            ""
        };
        let default = match &self.default {
            None | Some(ColumnDefault::Thunk(_)) => String::new(),
            Some(ColumnDefault::Sql(sql)) => format!("default {sql}"),
            Some(ColumnDefault::Value(Val::Null)) => "default null".into(),
            Some(ColumnDefault::Value(v)) => {
                let encoded = self
                    .schema
                    .encode(v.clone())
                    .unwrap_or_else(|e| panic!("default of column {}: {e}", self.name))
                    .js_to_string();
                if self.ty == ColumnType::Text {
                    format!("default '{encoded}'")
                } else {
                    format!("default {encoded}")
                }
            }
        };
        format!(
            "\"{}\" {} {pk} {auto} {nullable} {default}",
            self.name,
            self.ty.as_sql()
        )
    }

    fn rebuild_schema(mut self) -> Self {
        self.schema = if self.nullable {
            s::null_or(self.base.clone())
        } else {
            self.base.clone()
        };
        self
    }
}

/// `withPrimaryKey`.
pub fn with_primary_key(schema: &ValueSchema) -> ValueSchema {
    schema.annotate(PRIMARY_KEY_ID, Annotation::Bool(true))
}

/// `withColumnType` (compatibility validation is a TODO in TS too).
pub fn with_column_type(schema: &ValueSchema, ty: ColumnType) -> ValueSchema {
    schema.annotate(COLUMN_TYPE, Annotation::Str(ty.as_sql().into()))
}

pub fn with_auto_increment(schema: &ValueSchema) -> ValueSchema {
    schema.annotate(AUTO_INCREMENT, Annotation::Bool(true))
}

pub fn with_unique(schema: &ValueSchema) -> ValueSchema {
    schema.annotate(UNIQUE, Annotation::Bool(true))
}

pub fn with_default(schema: &ValueSchema, value: impl Into<ColumnDefault>) -> ValueSchema {
    schema.annotate(DEFAULT, Annotation::Default(value.into()))
}

/// `getColumnDefForSchema`: maps a value schema to a column, respecting column annotations. The column is unnamed.
pub fn get_column_def_for_schema(schema: &ValueSchema) -> Column {
    column_def_for_schema(schema, false)
}

/// `schemaFieldsToColumns`: optional fields become nullable columns; returns columns and unique column names.
pub fn schema_fields_to_columns(
    fields: &[(String, ValueSchema)],
) -> Result<(Vec<Column>, Vec<String>), TableDefError> {
    let mut columns = vec![];
    let mut unique = vec![];
    for (name, field) in fields {
        if field.is_optional() && has_null(field) && has_undefined(field) {
            tracing::warn!(
                "Field '{name}' has both null and undefined - treating | undefined as | null"
            );
        }
        let mut column = column_def_for_schema(field, field.is_optional()).named(name);
        column.primary_key |= field.annotation_bool(PRIMARY_KEY_ID);
        if column.primary_key && column.nullable {
            return Err(TableDefError(
                "Primary key columns cannot be nullable".into(),
            ));
        }
        if field.annotation_bool(UNIQUE) {
            unique.push(name.clone());
        }
        columns.push(column);
    }
    Ok((columns, unique))
}

impl fmt::Debug for ColumnDefault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Value(v) => write!(f, "Value({v:?})"),
            Self::Thunk(_) => write!(f, "Thunk"),
            Self::Sql(sql) => write!(f, "Sql({sql})"),
        }
    }
}

impl<T: Into<Val>> From<T> for ColumnDefault {
    fn from(v: T) -> Self {
        Self::Value(v.into())
    }
}

fn column_def_for_schema(schema: &ValueSchema, force_nullable: bool) -> Column {
    let nullable = force_nullable || has_null(schema) || has_undefined(schema);
    let mut column = match schema.annotation_str(COLUMN_TYPE) {
        Some(ty) => column_for_type(ty, nullable),
        None => column_for_schema(schema, nullable),
    };
    column.primary_key |= schema.annotation_bool(PRIMARY_KEY_ID);
    column.auto_increment |= schema.annotation_bool(AUTO_INCREMENT);
    if let Some(Annotation::Default(default)) = schema.annotation(DEFAULT) {
        column.default = Some(default.clone());
    }
    column
}

fn column_for_type(ty: &str, nullable: bool) -> Column {
    let column = match ty {
        "text" => Column::text(""),
        "integer" => Column::integer(""),
        "real" => Column::real(""),
        "blob" => Column::blob(""),
        other => panic!("Unsupported column type: {other}"),
    };
    if nullable { column.nullable() } else { column }
}

fn column_for_schema(schema: &ValueSchema, nullable: bool) -> Column {
    let core = strip_nullable(schema);
    let with = |column: Column| {
        let column = column.schema(core.clone());
        if nullable { column.nullable() } else { column }
    };
    if matches!(core.ast(), Ast::Boolean) {
        let column = Column::boolean("");
        return if nullable { column.nullable() } else { column };
    }

    let encoded = core.to_encoded();
    if strip_nullable(&encoded).representation() == Some(DATE_REPRESENTATION) {
        // Adapt the encoded Date to ISO text, then run the original codec so its checks and transformations hold.
        let encoded_nullable = has_null(&encoded);
        let storage = if encoded_nullable {
            s::null_or(s::date_from_string())
        } else {
            s::date_from_string()
        };
        let adapted = core.decode_from_passthrough(&storage);
        let mut column = Column::datetime("");
        column.schema = if nullable {
            s::null_or(adapted)
        } else {
            adapted
        };
        column.nullable = nullable || encoded_nullable;
        return column;
    }

    match encoded.ast() {
        Ast::String => return with(Column::text("")),
        Ast::Number => {
            let integer =
                has_int_check(&core) || core.representation() == Some(DATE_REPRESENTATION);
            return with(if integer {
                Column::integer("")
            } else {
                Column::real("")
            });
        }
        _ => {}
    }
    if is_uint8array(&core) || is_uint8array(&encoded) {
        return with(Column::blob(""));
    }
    if let Some(column) =
        literal_column(&encoded, &core, nullable).or_else(|| literal_column(&core, &core, nullable))
    {
        return column;
    }
    with(Column::json(""))
}

fn literal_column(ast: &ValueSchema, source: &ValueSchema, nullable: bool) -> Option<Column> {
    let values: Vec<Val> = match ast.ast() {
        Ast::Literal(v) => vec![v.clone()],
        Ast::Union(members) if !members.is_empty() => members
            .iter()
            .map(|m| {
                if let Ast::Literal(v) = m.ast() {
                    Some(v.clone())
                } else {
                    None
                }
            })
            .collect::<Option<_>>()?,
        _ => return None,
    };
    let kind = |v: &Val| match v {
        Val::String(_) => "string",
        Val::Number(_) => "number",
        Val::Bool(_) => "boolean",
        Val::BigInt(_) => "bigint",
        _ => "other",
    };
    let first = kind(&values[0]);
    if values.iter().any(|v| kind(v) != first) {
        return None;
    }
    let column = match first {
        "string" => Column::text("").schema(source.clone()),
        "number" => {
            let all_ints = values.len() > 1
                && values
                    .iter()
                    .all(|v| matches!(v, Val::Number(n) if n.fract() == 0.0));
            let integer = has_int_check(source)
                || source.representation() == Some(DATE_REPRESENTATION)
                || all_ints;
            if integer {
                Column::integer("")
            } else {
                Column::real("")
            }
            .schema(source.clone())
        }
        "boolean" => Column::boolean(""),
        "bigint" => Column::integer("").schema(source.clone()),
        _ => return None,
    };
    Some(if nullable { column.nullable() } else { column })
}

fn has_int_check(schema: &ValueSchema) -> bool {
    schema
        .checks()
        .iter()
        .any(|c| c.representation == Some(IS_INT))
}

fn is_uint8array(schema: &ValueSchema) -> bool {
    schema.representation() == Some(UINT8ARRAY_REPRESENTATION)
        || schema
            .annotation_str("identifier")
            .is_some_and(|id| id.contains("Uint8Array"))
        || matches!(schema.ast(), Ast::Arrays { elements, rest: Some(rest) } if elements.is_empty() && matches!(rest.ast(), Ast::Number))
}

pub(crate) fn has_null(schema: &ValueSchema) -> bool {
    match schema.ast() {
        Ast::Null => true,
        Ast::Union(members) => members.iter().any(has_null),
        _ => false,
    }
}

pub(crate) fn has_undefined(schema: &ValueSchema) -> bool {
    match schema.ast() {
        Ast::Undefined => true,
        Ast::Union(members) => members.iter().any(has_undefined),
        _ => false,
    }
}

/// Drops `null`/`undefined` union members, keeping the union's annotations when several members remain.
fn strip_nullable(schema: &ValueSchema) -> ValueSchema {
    let Ast::Union(members) = schema.ast() else {
        return schema.clone();
    };
    let core: Vec<ValueSchema> = members
        .iter()
        .filter(|m| !matches!(m.ast(), Ast::Null | Ast::Undefined))
        .cloned()
        .collect();
    match core.len() {
        0 => schema.clone(),
        n if n == members.len() => schema.clone(),
        1 => core[0].clone(),
        _ => schema.with_union_members(core),
    }
}
