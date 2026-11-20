//! Query builder (`schema/state/sqlite/query-builder`: `impl.ts`, `astToSql.ts`, `getResultSchema`).
//!
//! `table.query()` starts a SELECT; `.count()`, `.insert()`, `.update()` and `.delete()` switch to the
//! other query kinds, each its own type so only valid chains compile. Values are the decoded JSON form
//! (dates as ISO strings) and are encoded per column like the TS column schemas.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

use crate::codec::{date_from_iso_string, iso_string_from_millis};
use crate::table::{Column, ColumnKind, Table};
use crate::value::{SqlStatement, SqlValue};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Like,
    NotLike,
    ILike,
    NotILike,
    In,
    NotIn,
    JsonContains,
    JsonNotContains,
}

impl Op {
    pub fn as_sql(self) -> &'static str {
        match self {
            Op::Eq => "=",
            Op::Ne => "!=",
            Op::Lt => "<",
            Op::Gt => ">",
            Op::Le => "<=",
            Op::Ge => ">=",
            Op::Like => "LIKE",
            Op::NotLike => "NOT LIKE",
            Op::ILike => "ILIKE",
            Op::NotILike => "NOT ILIKE",
            Op::In => "IN",
            Op::NotIn => "NOT IN",
            Op::JsonContains => "JSON_CONTAINS",
            Op::JsonNotContains => "JSON_NOT_CONTAINS",
        }
    }
}

/// One entry of the object form `where({ col: value | { op, value } | undefined })`.
#[derive(Clone, Debug, PartialEq)]
pub enum Cond {
    Value(Value),
    Op(Op, Value),
    Undefined,
}

impl From<Value> for Cond {
    fn from(v: Value) -> Self {
        Cond::Value(v)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Asc,
    Desc,
}

/// `.first({ behaviour })`.
#[derive(Clone, Debug, PartialEq)]
pub enum First {
    Undefined,
    Error,
    Fallback(Value),
}

/// `.onConflict(targets, action, update?)`.
#[derive(Clone, Debug, PartialEq)]
pub enum OnConflict {
    Ignore,
    Replace,
    Update(Vec<(String, Value)>),
}

/// `asSql()` output.
#[derive(Clone, Debug, PartialEq)]
pub struct SqlQuery {
    pub query: String,
    pub bind_values: Vec<SqlValue>,
    pub used_tables: BTreeSet<String>,
}

impl From<SqlQuery> for SqlStatement {
    fn from(q: SqlQuery) -> Self {
        SqlStatement::new(q.query, q.bind_values)
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum QueryBuilderError {
    #[error("Invalid query builder: {0}")]
    Invalid(String),
    #[error("Column {0} not found")]
    ColumnNotFound(String),
    #[error("Unsupported operator for NULL value: {0}")]
    UnsupportedNullOp(&'static str),
    #[error(
        "{op} operator can only be used on JSON array columns, but column \"{col}\" is not a JSON array"
    )]
    NotJsonArray { op: &'static str, col: String },
    #[error("Expected array value for {0} operator")]
    ExpectedArray(&'static str),
    #[error("No update columns provided for ON CONFLICT DO UPDATE")]
    EmptyConflictUpdate,
    #[error("Missing key at [\"{0}\"]")]
    MissingKey(String),
    #[error("Expected {expected} for column \"{col}\", got {actual}")]
    Encode {
        col: String,
        expected: &'static str,
        actual: String,
    },
    #[error("Unable to retrieve the first element of an empty array")]
    EmptyArray,
    #[error("Expected {0}")]
    Decode(String),
}

type Result<T> = std::result::Result<T, QueryBuilderError>;

#[derive(Clone, Debug, PartialEq)]
pub struct Where {
    col: String,
    op: Op,
    value: Value,
}

/// Shared `.where(...)` overloads for SELECT, COUNT, UPDATE and DELETE.
pub trait Filter: Sized {
    #[doc(hidden)]
    fn wheres(&mut self) -> &mut Vec<Where>;

    /// `where(col, value)`.
    fn where_eq(self, col: &str, value: Value) -> Self {
        self.where_op(col, Op::Eq, value)
    }

    /// `where(col, op, value)`.
    fn where_op(mut self, col: &str, op: Op, value: Value) -> Self {
        self.wheres().push(Where {
            col: col.into(),
            op,
            value,
        });
        self
    }

    /// `where({ ... })`; [`Cond::Undefined`] entries are dropped.
    fn where_all<'a>(mut self, conds: impl IntoIterator<Item = (&'a str, Cond)>) -> Self {
        for (col, cond) in conds {
            let (op, value) = match cond {
                Cond::Undefined => continue,
                Cond::Value(v) => (Op::Eq, v),
                Cond::Op(op, v) => (op, v),
            };
            self.wheres().push(Where {
                col: col.into(),
                op,
                value,
            });
        }
        self
    }
}

impl Table {
    /// The table's query builder (`db.todos` in TS).
    pub fn query(&self) -> Select<'_> {
        Select {
            table: self,
            columns: vec![],
            wheres: vec![],
            order_by: vec![],
            limit: None,
            offset: None,
            first: None,
            invalid: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Select<'t> {
    table: &'t Table,
    columns: Vec<String>,
    wheres: Vec<Where>,
    order_by: Vec<(String, Direction)>,
    limit: Option<i64>,
    offset: Option<i64>,
    first: Option<First>,
    invalid: Option<String>,
}

impl Filter for Select<'_> {
    fn wheres(&mut self) -> &mut Vec<Where> {
        &mut self.wheres
    }
}

impl<'t> Select<'t> {
    /// `select(...cols)`; a single column plucks its values.
    pub fn select(mut self, columns: &[&str]) -> Self {
        self.columns = columns.iter().map(|c| (*c).into()).collect();
        self
    }

    pub fn order_by(mut self, col: &str, direction: Direction) -> Self {
        self.order_by.push((col.into(), direction));
        self
    }

    /// `orderBy([{ col, direction }, ...])`.
    pub fn order_by_all<'a>(
        mut self,
        items: impl IntoIterator<Item = (&'a str, Direction)>,
    ) -> Self {
        self.order_by
            .extend(items.into_iter().map(|(c, d)| (c.to_string(), d)));
        self
    }

    pub fn limit(mut self, limit: i64) -> Self {
        self.limit = Some(limit);
        self
    }

    pub fn offset(mut self, offset: i64) -> Self {
        self.offset = Some(offset);
        self
    }

    /// The queried table.
    pub fn table(&self) -> &'t Table {
        self.table
    }

    /// The same query over another (structurally equal) table definition, e.g. an owned copy.
    pub fn rebind<'u>(&self, table: &'u Table) -> Select<'u> {
        Select {
            table,
            columns: self.columns.clone(),
            wheres: self.wheres.clone(),
            order_by: self.order_by.clone(),
            limit: self.limit,
            offset: self.offset,
            first: self.first.clone(),
            invalid: self.invalid.clone(),
        }
    }

    pub fn first(mut self, behaviour: First) -> Self {
        if self.limit.is_some() {
            self.invalid = Some(".first() can't be called after .limit()".into());
        }
        self.limit = Some(1);
        self.first = Some(behaviour);
        self
    }

    pub fn count(self) -> Count<'t> {
        Count {
            table: self.table,
            wheres: self.wheres,
        }
    }

    /// `insert(values)`: a fresh INSERT (TS drops the SELECT state too).
    pub fn insert<'a>(self, values: impl IntoIterator<Item = (&'a str, Value)>) -> Insert<'t> {
        Insert {
            table: self.table,
            values: pairs(values),
            on_conflict: None,
            returning: vec![],
        }
    }

    /// `update(values)`, keeping the WHERE clauses collected so far.
    pub fn update<'a>(self, values: impl IntoIterator<Item = (&'a str, Value)>) -> Update<'t> {
        Update {
            table: self.table,
            values: pairs(values),
            wheres: self.wheres,
            returning: vec![],
        }
    }

    /// `delete()`, keeping the WHERE clauses collected so far.
    pub fn delete(self) -> Delete<'t> {
        Delete {
            table: self.table,
            wheres: self.wheres,
            returning: vec![],
        }
    }

    pub fn as_sql(&self) -> Result<SqlQuery> {
        if let Some(msg) = &self.invalid {
            return Err(QueryBuilderError::Invalid(msg.clone()));
        }
        let mut binds = vec![];
        let columns = if self.columns.is_empty() {
            "*".into()
        } else {
            self.columns
                .iter()
                .map(|c| quote(c))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let where_stmt = where_clause(&self.wheres, self.table, &mut binds)?;
        let order_stmt = if self.order_by.is_empty() {
            String::new()
        } else {
            let items: Vec<String> = self
                .order_by
                .iter()
                .map(|(c, d)| {
                    format!(
                        "{} {}",
                        quote(c),
                        if *d == Direction::Asc { "asc" } else { "desc" }
                    )
                })
                .collect();
            format!("ORDER BY {}", items.join(", "))
        };
        let limit_stmt = if self.limit.is_some() { "LIMIT ?" } else { "" };
        let offset_stmt = if self.offset.is_some() {
            "OFFSET ?"
        } else {
            ""
        };
        binds.extend(self.limit.map(SqlValue::Integer));
        binds.extend(self.offset.map(SqlValue::Integer));
        let query = [
            format!("SELECT {columns}"),
            format!("FROM '{}'", self.table.name),
            where_stmt,
            order_stmt,
            limit_stmt.into(),
            offset_stmt.into(),
        ]
        .into_iter()
        .filter(|c| !c.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        Ok(sql_query(self.table, query, binds))
    }

    /// `getResultSchema(qb)` decode: SQLite rows (JSON) to the query result.
    pub fn decode_result(&self, rows: &Value) -> Result<Value> {
        let rows = rows
            .as_array()
            .ok_or_else(|| QueryBuilderError::Decode("an array".into()))?;
        let decode = |row: &Value| -> Result<Value> {
            let decoded = decode_row(self.table, row, &self.columns)?;
            Ok(if self.columns.len() == 1 {
                decoded[&self.columns[0]].clone()
            } else {
                decoded
            })
        };
        match &self.first {
            None => Ok(Value::Array(
                rows.iter().map(decode).collect::<Result<_>>()?,
            )),
            Some(first) => match (rows.first(), first) {
                (Some(row), _) => decode(row),
                (None, First::Error) => Err(QueryBuilderError::EmptyArray),
                (None, First::Undefined) => Ok(Value::Null),
                (None, First::Fallback(v)) => Ok(v.clone()),
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct Count<'t> {
    table: &'t Table,
    wheres: Vec<Where>,
}

impl Filter for Count<'_> {
    fn wheres(&mut self) -> &mut Vec<Where> {
        &mut self.wheres
    }
}

impl Count<'_> {
    pub fn as_sql(&self) -> Result<SqlQuery> {
        let mut binds = vec![];
        let mut query = format!("SELECT COUNT(*) as count FROM '{}'", self.table.name);
        let where_stmt = where_clause(&self.wheres, self.table, &mut binds)?;
        if !where_stmt.is_empty() {
            query = format!("{query} {where_stmt}");
        }
        Ok(sql_query(self.table, query, binds))
    }

    pub fn decode_result(&self, rows: &Value) -> Result<Value> {
        let row = rows
            .as_array()
            .ok_or_else(|| QueryBuilderError::Decode("an array".into()))?
            .first()
            .ok_or(QueryBuilderError::EmptyArray)?;
        row.get("count")
            .filter(|c| c.is_number())
            .cloned()
            .ok_or_else(|| QueryBuilderError::Decode("a finite count".into()))
    }
}

#[derive(Clone, Debug)]
pub struct Insert<'t> {
    table: &'t Table,
    values: Vec<(String, Value)>,
    on_conflict: Option<(Vec<String>, OnConflict)>,
    returning: Vec<String>,
}

impl Insert<'_> {
    pub fn on_conflict(mut self, targets: &[&str], action: OnConflict) -> Self {
        self.on_conflict = Some((targets.iter().map(|t| (*t).into()).collect(), action));
        self
    }

    pub fn returning(mut self, columns: &[&str]) -> Self {
        self.returning = columns.iter().map(|c| (*c).into()).collect();
        self
    }

    pub fn as_sql(&self) -> Result<SqlQuery> {
        // `insertSchema`: columns without a default that are not nullable are required.
        for col in &self.table.columns {
            if !col.nullable
                && col.default.is_none()
                && !self.values.iter().any(|(c, _)| *c == col.name)
            {
                return Err(QueryBuilderError::MissingKey(col.name.clone()));
            }
        }
        let mut binds = vec![];
        for (col, value) in &self.values {
            binds.push(encode(column(self.table, col)?, value)?);
        }
        let mut verb = "INSERT";
        let mut conflict = String::new();
        match &self.on_conflict {
            None => {}
            Some((_, OnConflict::Replace)) => verb = "INSERT OR REPLACE",
            Some((targets, action)) => {
                let targets: Vec<String> = targets.iter().map(|t| quote(t)).collect();
                conflict = format!(" ON CONFLICT ({}) ", targets.join(", "));
                if let OnConflict::Update(values) = action {
                    if values.is_empty() {
                        return Err(QueryBuilderError::EmptyConflictUpdate);
                    }
                    let mut sets = vec![];
                    for (col, value) in values {
                        sets.push(format!("{} = ?", quote(col)));
                        binds.push(encode(column(self.table, col)?, value)?);
                    }
                    conflict.push_str(&format!("DO UPDATE SET {}", sets.join(", ")));
                } else {
                    conflict.push_str("DO NOTHING");
                }
            }
        }
        let cols: Vec<String> = self.values.iter().map(|(c, _)| quote(c)).collect();
        let marks = vec!["?"; cols.len()].join(", ");
        let query = format!(
            "{verb} INTO '{}' ({}) VALUES ({marks}){conflict}{}",
            self.table.name,
            cols.join(", "),
            returning(&self.returning)
        );
        Ok(sql_query(self.table, query, binds))
    }

    pub fn decode_result(&self, result: &Value) -> Result<Value> {
        decode_write_result(self.table, &self.returning, result)
    }
}

#[derive(Clone, Debug)]
pub struct Update<'t> {
    table: &'t Table,
    values: Vec<(String, Value)>,
    wheres: Vec<Where>,
    returning: Vec<String>,
}

impl Filter for Update<'_> {
    fn wheres(&mut self) -> &mut Vec<Where> {
        &mut self.wheres
    }
}

impl Update<'_> {
    pub fn returning(mut self, columns: &[&str]) -> Self {
        self.returning = columns.iter().map(|c| (*c).into()).collect();
        self
    }

    pub fn as_sql(&self) -> Result<SqlQuery> {
        if self.values.is_empty() {
            tracing::warn!(
                table = %self.table.name,
                "UPDATE query requires at least one column to set. Running no-op query instead to skip this update query."
            );
            return Ok(sql_query(self.table, "SELECT 1".into(), vec![]));
        }
        let mut binds = vec![];
        for (col, value) in &self.values {
            binds.push(encode(column(self.table, col)?, value)?);
        }
        let sets: Vec<String> = self
            .values
            .iter()
            .map(|(c, _)| format!("{} = ?", quote(c)))
            .collect();
        let where_stmt = where_clause(&self.wheres, self.table, &mut binds)?;
        let query = format!(
            "UPDATE '{}' SET {} {where_stmt}{}",
            self.table.name,
            sets.join(", "),
            returning(&self.returning)
        );
        Ok(sql_query(self.table, query, binds))
    }

    pub fn decode_result(&self, result: &Value) -> Result<Value> {
        decode_write_result(self.table, &self.returning, result)
    }
}

#[derive(Clone, Debug)]
pub struct Delete<'t> {
    table: &'t Table,
    wheres: Vec<Where>,
    returning: Vec<String>,
}

impl Filter for Delete<'_> {
    fn wheres(&mut self) -> &mut Vec<Where> {
        &mut self.wheres
    }
}

impl Delete<'_> {
    pub fn returning(mut self, columns: &[&str]) -> Self {
        self.returning = columns.iter().map(|c| (*c).into()).collect();
        self
    }

    pub fn as_sql(&self) -> Result<SqlQuery> {
        let mut binds = vec![];
        let where_stmt = where_clause(&self.wheres, self.table, &mut binds)?;
        let query = format!(
            "DELETE FROM '{}' {where_stmt}{}",
            self.table.name,
            returning(&self.returning)
        );
        Ok(sql_query(self.table, query, binds))
    }

    pub fn decode_result(&self, result: &Value) -> Result<Value> {
        decode_write_result(self.table, &self.returning, result)
    }
}

fn pairs<'a>(values: impl IntoIterator<Item = (&'a str, Value)>) -> Vec<(String, Value)> {
    values
        .into_iter()
        .map(|(c, v)| (c.to_string(), v))
        .collect()
}

fn sql_query(table: &Table, query: String, bind_values: Vec<SqlValue>) -> SqlQuery {
    SqlQuery {
        query,
        bind_values,
        used_tables: BTreeSet::from([table.name.clone()]),
    }
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn returning(columns: &[String]) -> String {
    if columns.is_empty() {
        return String::new();
    }
    format!(
        " RETURNING {}",
        columns
            .iter()
            .map(|c| quote(c))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn column<'t>(table: &'t Table, name: &str) -> Result<&'t Column> {
    table
        .columns
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| QueryBuilderError::ColumnNotFound(name.into()))
}

fn where_clause(wheres: &[Where], table: &Table, binds: &mut Vec<SqlValue>) -> Result<String> {
    if wheres.is_empty() {
        return Ok(String::new());
    }
    let mut parts = vec![];
    for Where { col, op, value } in wheres {
        let quoted = quote(col);
        if value.is_null() {
            let stmt = match op {
                Op::Eq => "IS",
                Op::Ne => "IS NOT",
                other => return Err(QueryBuilderError::UnsupportedNullOp(other.as_sql())),
            };
            parts.push(format!("{quoted} {stmt} NULL"));
            continue;
        }
        let col_def = column(table, col)?;
        match op {
            Op::JsonContains | Op::JsonNotContains => {
                if !is_json_array(col_def) {
                    return Err(QueryBuilderError::NotJsonArray {
                        op: op.as_sql(),
                        col: col.clone(),
                    });
                }
                binds.push(json_each_value(value));
                let exists = if *op == Op::JsonContains {
                    "EXISTS"
                } else {
                    "NOT EXISTS"
                };
                parts.push(format!(
                    "{exists} (SELECT 1 FROM json_each({quoted}) WHERE value = ?)"
                ));
            }
            Op::In | Op::NotIn => {
                let items = value
                    .as_array()
                    .ok_or(QueryBuilderError::ExpectedArray(op.as_sql()))?;
                if items.is_empty() {
                    parts.push(if *op == Op::In { "0=1" } else { "1=1" }.into());
                    continue;
                }
                for item in items {
                    binds.push(encode(col_def, item)?);
                }
                parts.push(format!(
                    "{quoted} {} ({})",
                    op.as_sql(),
                    vec!["?"; items.len()].join(", ")
                ));
            }
            _ => {
                binds.push(encode(col_def, value)?);
                parts.push(format!("{quoted} {} ?", op.as_sql()));
            }
        }
    }
    Ok(format!("WHERE {}", parts.join(" AND ")))
}

/// A JSON column whose decoded (type-side) schema representation is an array.
fn is_json_array(col: &Column) -> bool {
    col.kind == ColumnKind::Json
        && col
            .schema_repr
            .clone()
            .unwrap_or_else(|| crate::representation::representation_document(&col.schema))["representations"]
            [1]["_tag"]
            == "Arrays"
}

/// `json_each()` yields scalars as-is and objects/arrays as JSON text.
fn json_each_value(value: &Value) -> SqlValue {
    match value {
        Value::Object(_) | Value::Array(_) => SqlValue::Text(value.to_string()),
        other => other.into(),
    }
}

/// Encodes a decoded value with the column schema (`Schema.encodeSync(colDef.schema)`).
fn encode(col: &Column, value: &Value) -> Result<SqlValue> {
    let fail = |expected: &'static str| QueryBuilderError::Encode {
        col: col.name.clone(),
        expected,
        actual: value.to_string(),
    };
    if value.is_null() {
        return if col.nullable {
            Ok(SqlValue::Null)
        } else {
            Err(fail("a non-null value"))
        };
    }
    Ok(match col.kind {
        ColumnKind::Text => SqlValue::Text(value.as_str().ok_or_else(|| fail("a string"))?.into()),
        ColumnKind::Integer => SqlValue::Integer(value.as_i64().ok_or_else(|| fail("an integer"))?),
        ColumnKind::Real => SqlValue::Real(value.as_f64().ok_or_else(|| fail("a number"))?),
        ColumnKind::Boolean => SqlValue::from(value.as_bool().ok_or_else(|| fail("a boolean"))?),
        ColumnKind::Datetime => {
            let ms = value
                .as_str()
                .and_then(date_from_iso_string)
                .ok_or_else(|| fail("a valid date"))?;
            SqlValue::Text(iso_string_from_millis(ms))
        }
        ColumnKind::DatetimeMillis => SqlValue::Integer(
            value
                .as_str()
                .and_then(date_from_iso_string)
                .ok_or_else(|| fail("a valid date"))?,
        ),
        ColumnKind::Json => SqlValue::Text(value.to_string()),
        ColumnKind::Blob => {
            let bytes = value.as_array().and_then(|a| {
                a.iter()
                    .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
                    .collect::<Option<Vec<u8>>>()
            });
            SqlValue::Blob(bytes.ok_or_else(|| fail("a byte array"))?)
        }
    })
}

/// Decodes one SQLite row (JSON object) with the row schema, keeping `columns` (all when empty).
fn decode_row(table: &Table, row: &Value, columns: &[String]) -> Result<Value> {
    let row = row
        .as_object()
        .ok_or_else(|| QueryBuilderError::Decode("a row object".into()))?;
    let mut out = Map::new();
    for col in &table.columns {
        if !columns.is_empty() && !columns.contains(&col.name) {
            continue;
        }
        let raw = row
            .get(&col.name)
            .ok_or_else(|| QueryBuilderError::MissingKey(col.name.clone()))?;
        out.insert(col.name.clone(), decode(col, raw)?);
    }
    Ok(Value::Object(out))
}

fn decode(col: &Column, raw: &Value) -> Result<Value> {
    let fail = |expected: &str| {
        QueryBuilderError::Decode(format!("{expected} for column \"{}\", got {raw}", col.name))
    };
    if raw.is_null() {
        return if col.nullable {
            Ok(Value::Null)
        } else {
            Err(fail("a non-null value"))
        };
    }
    Ok(match col.kind {
        ColumnKind::Text | ColumnKind::Datetime if raw.is_string() => raw.clone(),
        ColumnKind::Integer | ColumnKind::Real if raw.is_number() => raw.clone(),
        ColumnKind::Blob if raw.is_array() => raw.clone(),
        ColumnKind::Boolean => Value::Bool(raw.as_i64().ok_or_else(|| fail("0 or 1"))? != 0),
        ColumnKind::DatetimeMillis => Value::String(iso_string_from_millis(
            raw.as_i64().ok_or_else(|| fail("epoch millis"))?,
        )),
        ColumnKind::Json => serde_json::from_str(raw.as_str().ok_or_else(|| fail("JSON text"))?)
            .map_err(|_| fail("valid JSON"))?,
        _ => return Err(fail("a value matching the column type")),
    })
}

fn decode_write_result(table: &Table, returning: &[String], result: &Value) -> Result<Value> {
    if returning.is_empty() {
        return result
            .is_number()
            .then(|| result.clone())
            .ok_or_else(|| QueryBuilderError::Decode("a finite number".into()));
    }
    let rows = result
        .as_array()
        .ok_or_else(|| QueryBuilderError::Decode("an array".into()))?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| decode_row(table, r, returning))
            .collect::<Result<_>>()?,
    ))
}
