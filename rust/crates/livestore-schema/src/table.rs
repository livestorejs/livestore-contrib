//! `State.SQLite.table` (`table-def.ts`) from columns or a value schema, `makeColumnSpec`
//! (`column-spec.ts`), row/insert schemas, default values (`schema-helpers.ts`) and the simple
//! insert/update statements materializers use.

use indexmap::IndexMap;

use crate::column::schema_fields_to_columns;
pub use crate::column::{Column, ColumnDefault, ColumnKind, ColumnType, TableDefError};
use crate::value::{SqlStatement, SqlValue};
use crate::value_schema::{self as s, Ast, SchemaError, Val, ValueSchema};

/// Former name of [`ColumnDefault`].
pub type DefaultValue = ColumnDefault;

#[derive(Clone, Debug, PartialEq)]
pub struct Index {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Clone, Debug)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub is_client_document_table: bool,
}

impl Table {
    #[must_use]
    pub fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            columns: vec![],
            indexes: vec![],
            is_client_document_table: false,
        }
    }

    /// `table({ name, columns: <single column> })`: the column is named `value`.
    #[must_use]
    pub fn single_column(name: &str, column: Column) -> Self {
        Self::new(name).column(column.named("value"))
    }

    /// `table({ name?, schema, indexes })`. Columns follow the encoded side of the schema; unique
    /// annotations add `idx_<table>_<column>_unique` indexes after `indexes`.
    ///
    /// # Errors
    ///
    /// Fails when a primary key field is nullable, or when `name` is `None` and the schema has no
    /// `title` or `identifier` annotation.
    pub fn from_schema(
        name: Option<&str>,
        schema: &ValueSchema,
        indexes: Vec<Index>,
    ) -> Result<Self, TableDefError> {
        let (columns, unique) = schema_fields_to_columns(&sqlite_property_signatures(schema))?;
        let name = match name {
            Some(name) => name.to_string(),
            None => schema.annotation_str("title").or_else(|| schema.annotation_str("identifier")).map(str::to_string).ok_or_else(|| {
                TableDefError("When using schema without explicit name, the schema must have a title or identifier annotation".into())
            })?,
        };
        let unique_indexes = unique.into_iter().map(|c| Index {
            name: format!("idx_{name}_{c}_unique"),
            columns: vec![c],
            unique: true,
        });
        let indexes = indexes.into_iter().chain(unique_indexes).collect();
        Ok(Self {
            name,
            columns,
            indexes,
            is_client_document_table: false,
        })
    }

    /// # Panics
    ///
    /// Panics when the table has no column called `name`.
    #[must_use]
    pub fn col(&self, name: &str) -> &Column {
        self.columns
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no column {name} in {}", self.name))
    }

    /// `rowSchema`: struct of the column codecs.
    #[must_use]
    pub fn row_schema(&self) -> ValueSchema {
        s::struct_(
            self.columns
                .iter()
                .map(|c| (c.name.clone(), c.schema.clone())),
        )
        .title(&self.name)
    }

    /// `insertSchema`: nullable or defaulted columns are optional.
    #[must_use]
    pub fn insert_schema(&self) -> ValueSchema {
        let field = |c: &Column| {
            if c.nullable || c.default.is_some() {
                s::optional(c.schema.clone())
            } else {
                c.schema.clone()
            }
        };
        s::struct_(self.columns.iter().map(|c| (c.name.clone(), field(c)))).title(&self.name)
    }

    /// Encodes `insert(values)` like the query builder does: `undefined` values are dropped first.
    ///
    /// # Errors
    ///
    /// Fails when `values` is not an object or does not encode with the insert schema.
    pub fn encode_insert_values(&self, values: Val) -> Result<Val, SchemaError> {
        let Val::Object(values) = values else {
            return Err(SchemaError("insert values must be an object".into()));
        };
        self.insert_schema().encode(Val::Object(
            values
                .into_iter()
                .filter(|(_, v)| *v != Val::Undefined)
                .collect(),
        ))
    }

    /// `getDefaultValuesEncoded`.
    #[must_use]
    pub fn default_values_encoded(
        &self,
        fallback: &IndexMap<String, Val>,
    ) -> IndexMap<String, Val> {
        self.default_values(fallback, |c, v| c.schema.encode(v))
    }

    /// `getDefaultValuesDecoded`.
    #[must_use]
    pub fn default_values_decoded(
        &self,
        fallback: &IndexMap<String, Val>,
    ) -> IndexMap<String, Val> {
        self.default_values(fallback, |c, v| c.schema.to_type().decode(v))
    }

    fn default_values(
        &self,
        fallback: &IndexMap<String, Val>,
        convert: impl Fn(&Column, Val) -> Result<Val, SchemaError>,
    ) -> IndexMap<String, Val> {
        let mut out = IndexMap::new();
        for column in &self.columns {
            let fallback = fallback.get(&column.name).filter(|v| **v != Val::Undefined);
            if fallback.is_none()
                && (column.name == "id" || matches!(column.default, Some(ColumnDefault::Sql(_))))
            {
                continue;
            }
            let value = match (fallback, &column.default) {
                (Some(v), _) => v.clone(),
                (None, None) if column.nullable => Val::Null,
                (None, None) => panic!(
                    "Column {} has no default value and is not nullable",
                    column.name
                ),
                (None, Some(default)) => {
                    let resolved = default.resolve().expect("sql defaults are skipped");
                    convert(column, resolved)
                        .unwrap_or_else(|e| panic!("default of column {}: {e}", column.name))
                }
            };
            out.insert(column.name.clone(), value);
        }
        out
    }

    #[must_use]
    pub fn column(mut self, column: Column) -> Self {
        self.columns.push(column);
        self
    }

    #[must_use]
    pub fn index(mut self, name: &str, columns: &[&str]) -> Self {
        self.indexes.push(Index {
            name: name.into(),
            columns: columns.iter().map(|c| (*c).into()).collect(),
            unique: false,
        });
        self
    }

    #[must_use]
    pub fn unique_index(mut self, name: &str, columns: &[&str]) -> Self {
        self.indexes.push(Index {
            name: name.into(),
            columns: columns.iter().map(|c| (*c).into()).collect(),
            unique: true,
        });
        self
    }

    /// `makeColumnSpec`.
    #[must_use]
    pub fn column_spec(&self) -> String {
        let pks: Vec<&Column> = self.columns.iter().filter(|c| c.primary_key).collect();
        let single_pk = (pks.len() == 1).then(|| pks[0].name.as_str());
        let mut defs: Vec<String> = self
            .columns
            .iter()
            .map(|c| c.spec(single_pk == Some(c.name.as_str())))
            .collect();
        if pks.len() > 1 {
            let cols: Vec<String> = pks.iter().map(|c| format!("\"{}\"", c.name)).collect();
            defs.push(format!("PRIMARY KEY ({})", cols.join(", ")));
        }
        defs.join(", ")
    }

    /// `create table if not exists` plus index statements, exactly as `migrateTable` runs them.
    #[must_use]
    pub fn ddl(&self) -> Vec<String> {
        let mut out = vec![format!(
            "create table if not exists \"{}\" ({}) strict",
            self.name,
            self.column_spec()
        )];
        for index in &self.indexes {
            let unique = if index.unique { "UNIQUE" } else { "" };
            let cols: Vec<String> = index.columns.iter().map(|c| format!("\"{c}\"")).collect();
            out.push(format!(
                "create {unique} index if not exists \"{}\" on \"{}\" ({})",
                index.name,
                self.name,
                cols.join(", ")
            ));
        }
        out
    }

    /// `table.insert({...})`.
    pub fn insert<'a>(
        &self,
        values: impl IntoIterator<Item = (&'a str, SqlValue)>,
    ) -> SqlStatement {
        let (cols, binds): (Vec<&str>, Vec<SqlValue>) = values.into_iter().unzip();
        let marks = vec!["?"; cols.len()].join(", ");
        SqlStatement::new(
            format!(
                "INSERT INTO '{}' ({}) VALUES ({marks})",
                self.name,
                cols.join(", ")
            ),
            binds,
        )
    }

    /// `table.update({...})`; finish with [`Update::where_eq`] / [`Update::all`].
    pub fn update<'a>(&self, values: impl IntoIterator<Item = (&'a str, SqlValue)>) -> Update {
        let (cols, binds): (Vec<&str>, Vec<SqlValue>) = values.into_iter().unzip();
        let set: Vec<String> = cols.iter().map(|c| format!("{c} = ?")).collect();
        Update {
            sql: format!("UPDATE '{}' SET {}", self.name, set.join(", ")),
            binds,
        }
    }
}

pub struct Update {
    sql: String,
    binds: Vec<SqlValue>,
}

impl Update {
    pub fn where_eq<'a>(
        mut self,
        conditions: impl IntoIterator<Item = (&'a str, SqlValue)>,
    ) -> SqlStatement {
        let mut parts = vec![];
        for (col, value) in conditions {
            parts.push(format!("{col} = ?"));
            self.binds.push(value);
        }
        SqlStatement::new(
            format!("{} WHERE {}", self.sql, parts.join(" AND ")),
            self.binds,
        )
    }

    #[must_use]
    pub fn all(self) -> SqlStatement {
        SqlStatement::new(self.sql, self.binds)
    }
}

/// `getSqlitePropertySignatures`: the encoded side decides which columns exist; a property the schema
/// itself declares keeps its own codec (so `DateFromString` stores its encoded form), unless the
/// encoded property carries a `LiveStore` column annotation.
fn sqlite_property_signatures(schema: &ValueSchema) -> Vec<(String, ValueSchema)> {
    let own = property_signatures(schema);
    property_signatures(&schema.to_encoded())
        .into_iter()
        .map(
            |(name, encoded)| match own.iter().find(|(n, _)| *n == name) {
                Some((_, own)) if !has_livestore_annotation(&encoded) => (name, own.clone()),
                _ => (name, encoded),
            },
        )
        .collect()
}

/// Struct fields, a class's fields, or the fields common to every union member (as unions of the member types).
fn property_signatures(schema: &ValueSchema) -> Vec<(String, ValueSchema)> {
    match schema.ast() {
        Ast::Objects(fields) => fields.clone(),
        Ast::Declaration(_) => schema
            .encoding_from()
            .map(property_signatures)
            .unwrap_or_default(),
        Ast::Union(members) => {
            let members: Vec<_> = members.iter().map(property_signatures).collect();
            let Some((head, tail)) = members.split_first() else {
                return vec![];
            };
            head.iter()
                .filter_map(|(name, first)| {
                    let mut types = vec![first.clone()];
                    for member in tail {
                        types.push(member.iter().find(|(n, _)| n == name)?.1.clone());
                    }
                    let optional = types.iter().any(ValueSchema::is_optional);
                    let union = s::union(types);
                    Some((
                        name.clone(),
                        if optional {
                            s::optional_key(union)
                        } else {
                            union
                        },
                    ))
                })
                .collect()
        }
        _ => vec![],
    }
}

fn has_livestore_annotation(schema: &ValueSchema) -> bool {
    schema
        .annotation_keys()
        .any(|k| k.starts_with("livestore/state/sqlite/annotations/"))
}
