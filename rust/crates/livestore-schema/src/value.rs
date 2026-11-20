use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A bindable SQLite value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// A statement with positional `?` binds (TS `{ sql, bindValues }`).
#[derive(Clone, Debug, PartialEq)]
pub struct SqlStatement {
    pub sql: String,
    pub binds: Vec<SqlValue>,
}

impl SqlStatement {
    pub fn new(sql: impl Into<String>, binds: impl IntoIterator<Item = SqlValue>) -> Self {
        Self {
            sql: sql.into(),
            binds: binds.into_iter().collect(),
        }
    }
}

impl From<&str> for SqlValue {
    fn from(v: &str) -> Self {
        SqlValue::Text(v.into())
    }
}

impl From<String> for SqlValue {
    fn from(v: String) -> Self {
        SqlValue::Text(v)
    }
}

impl From<i64> for SqlValue {
    fn from(v: i64) -> Self {
        SqlValue::Integer(v)
    }
}

impl From<bool> for SqlValue {
    fn from(v: bool) -> Self {
        SqlValue::Integer(v.into())
    }
}

impl From<f64> for SqlValue {
    fn from(v: f64) -> Self {
        SqlValue::Real(v)
    }
}

impl<T: Into<SqlValue>> From<Option<T>> for SqlValue {
    fn from(v: Option<T>) -> Self {
        v.map_or(SqlValue::Null, Into::into)
    }
}

impl From<&Value> for SqlValue {
    /// JSON scalars map to their SQLite type; objects/arrays are stored as JSON text.
    fn from(v: &Value) -> Self {
        match v {
            Value::Null => SqlValue::Null,
            Value::Bool(b) => (*b).into(),
            Value::Number(n) => n.as_i64().map_or_else(
                || SqlValue::Real(n.as_f64().unwrap_or_default()),
                SqlValue::Integer,
            ),
            Value::String(s) => SqlValue::Text(s.clone()),
            other => SqlValue::Text(other.to_string()),
        }
    }
}
