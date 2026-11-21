//! The subset of Effect `Schema` (v4) that the SQLite DSL derives columns from.
//!
//! A [`ValueSchema`] is an AST node (the decoded/"Type" side) with optional checks, annotations, an
//! optional-key flag and an encoding link to the schema it decodes from — the same shape as Effect's
//! `SchemaAST`, so column derivation (`getColumnDefForSchema`) can ask the same questions: what is the
//! encoded AST, is it nullable, does it carry the `Date`/`Uint8Array` representation or an `isInt` check.
//! Values are dynamic [`Val`]s (JS values incl. `undefined`, `Date`, `Uint8Array`, `bigint`).

use std::fmt;
use std::sync::Arc;

use base64::Engine;
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::codec::{date_from_iso_string, iso_string_from_millis};
use crate::column::ColumnDefault;

pub const DATE_REPRESENTATION: &str = "effect/schema/Date";
pub const UINT8ARRAY_REPRESENTATION: &str = "effect/schema/Uint8Array";
pub const IS_INT: &str = "effect/schema/isInt";

/// A JS value as Effect schemas see it.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    BigInt(i128),
    String(String),
    Symbol(String),
    /// Epoch millis; `NaN` is an invalid date.
    Date(f64),
    Bytes(Vec<u8>),
    Array(Vec<Val>),
    Object(IndexMap<String, Val>),
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SchemaError(pub String);

pub type Transform = Arc<dyn Fn(Val) -> Result<Val, SchemaError> + Send + Sync>;

#[derive(Clone)]
pub struct ValueSchema(Arc<Node>);

#[derive(Clone)]
pub enum Ast {
    String,
    Number,
    Boolean,
    BigInt,
    Symbol,
    Null,
    Undefined,
    Void,
    Unknown,
    Any,
    Never,
    Literal(Val),
    Enum(Vec<(String, Val)>),
    Union(Vec<ValueSchema>),
    Objects(Vec<(String, ValueSchema)>),
    Record(ValueSchema),
    Arrays {
        elements: Vec<ValueSchema>,
        rest: Option<ValueSchema>,
    },
    Declaration(Declaration),
    /// A recursive reference. The name identifies the thunk, so describing a schema can detect the cycle.
    Suspend(&'static str, Arc<dyn Fn() -> ValueSchema + Send + Sync>),
}

#[derive(Clone, Debug)]
pub enum Declaration {
    Date,
    Uint8Array,
    /// `Schema.Class`: decodes from its fields struct (the encoding link and only type parameter).
    Class(String, ValueSchema),
}

#[derive(Clone)]
pub struct Check {
    pub representation: Option<&'static str>,
    /// Effect's check annotations (`expected`, `representation`, ...) in Effect's key order; `Null` for plain filters.
    pub annotations: Value,
    pub message: String,
    predicate: Arc<dyn Fn(&Val) -> bool + Send + Sync>,
}

#[derive(Clone)]
pub enum Annotation {
    Bool(bool),
    Str(String),
    Json(Value),
    Default(ColumnDefault),
}

#[derive(Clone)]
struct Node {
    ast: Ast,
    checks: Vec<Check>,
    annotations: IndexMap<String, Annotation>,
    /// Effect's `ast.encoding` chain: the last link's `from` is the most encoded side.
    encoding: Vec<Link>,
    optional: bool,
}

#[derive(Clone)]
pub(crate) struct Link {
    pub(crate) from: ValueSchema,
    decode: Transform,
    encode: Transform,
    /// `_tag`s of the transformation's decode and encode getters.
    pub(crate) getters: (&'static str, &'static str),
    /// `Schema.fromJsonString`: the link produces a JSON string (`content.mediaType`).
    pub(crate) json: bool,
}

impl ValueSchema {
    fn new(ast: Ast) -> Self {
        Self(Arc::new(Node {
            ast,
            checks: vec![],
            annotations: IndexMap::new(),
            encoding: vec![],
            optional: false,
        }))
    }

    fn map(&self, f: impl FnOnce(&mut Node)) -> Self {
        let mut node = (*self.0).clone();
        f(&mut node);
        Self(Arc::new(node))
    }

    /// Reference identity (`toBe` on schemas).
    #[must_use]
    pub fn same(&self, other: &ValueSchema) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    #[must_use]
    pub fn ast(&self) -> &Ast {
        &self.0.ast
    }

    /// `ast._tag`.
    #[must_use]
    pub fn tag(&self) -> &'static str {
        match &self.0.ast {
            Ast::String => "String",
            Ast::Number => "Number",
            Ast::Boolean => "Boolean",
            Ast::BigInt => "BigInt",
            Ast::Symbol => "Symbol",
            Ast::Null => "Null",
            Ast::Undefined => "Undefined",
            Ast::Void => "Void",
            Ast::Unknown => "Unknown",
            Ast::Any => "Any",
            Ast::Never => "Never",
            Ast::Literal(_) => "Literal",
            Ast::Enum(_) => "Enum",
            Ast::Union(_) => "Union",
            Ast::Objects(_) | Ast::Record(_) => "Objects",
            Ast::Arrays { .. } => "Arrays",
            Ast::Declaration(_) => "Declaration",
            Ast::Suspend(..) => "Suspend",
        }
    }

    #[must_use]
    pub fn checks(&self) -> &[Check] {
        &self.0.checks
    }

    #[must_use]
    pub fn is_optional(&self) -> bool {
        self.0.optional
    }

    #[must_use]
    pub fn has_encoding(&self) -> bool {
        !self.0.encoding.is_empty()
    }

    /// The most encoded schema this one decodes from (the last link's `to` in Effect terms).
    #[must_use]
    pub fn encoding_from(&self) -> Option<&ValueSchema> {
        self.0.encoding.last().map(|l| &l.from)
    }

    pub(crate) fn links(&self) -> &[Link] {
        &self.0.encoding
    }

    #[must_use]
    pub fn annotations(&self) -> &IndexMap<String, Annotation> {
        &self.0.annotations
    }

    pub(crate) fn with_union_members(&self, members: Vec<ValueSchema>) -> Self {
        self.map(|n| n.ast = Ast::Union(members))
    }

    /// `schema.pipe(f)`.
    pub fn pipe(&self, f: impl FnOnce(&Self) -> Self) -> Self {
        f(self)
    }

    #[must_use]
    pub fn check(&self, check: Check) -> Self {
        self.map(|n| n.checks.push(check))
    }

    #[must_use]
    pub fn annotate(&self, key: &str, value: Annotation) -> Self {
        self.map(|n| {
            n.annotations.insert(key.into(), value);
        })
    }

    #[must_use]
    pub fn title(&self, title: &str) -> Self {
        self.annotate("title", Annotation::Str(title.into()))
    }

    /// The `expected` annotation Effect's built-ins carry.
    #[must_use]
    pub fn expected(&self, expected: &str) -> Self {
        self.annotate("expected", Annotation::Str(expected.into()))
    }

    #[must_use]
    pub fn identifier(&self, identifier: &str) -> Self {
        self.annotate("identifier", Annotation::Str(identifier.into()))
    }

    #[must_use]
    pub fn annotation(&self, key: &str) -> Option<&Annotation> {
        self.0.annotations.get(key)
    }

    pub fn annotation_keys(&self) -> impl Iterator<Item = &str> {
        self.0.annotations.keys().map(String::as_str)
    }

    #[must_use]
    pub fn annotation_str(&self, key: &str) -> Option<&str> {
        match self.annotation(key)? {
            Annotation::Str(s) => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub fn annotation_bool(&self, key: &str) -> bool {
        matches!(self.annotation(key), Some(Annotation::Bool(true)))
    }

    /// `representation.id` of built-in declarations (`Date`, `Uint8Array`).
    #[must_use]
    pub fn representation(&self) -> Option<&'static str> {
        match &self.0.ast {
            Ast::Declaration(Declaration::Date) => Some(DATE_REPRESENTATION),
            Ast::Declaration(Declaration::Uint8Array) => Some(UINT8ARRAY_REPRESENTATION),
            _ => None,
        }
    }

    /// `from.pipe(Schema.decodeTo(self, { decode, encode }))`: `decode` maps `from`'s type to this schema's encoded form.
    pub fn decode_from(&self, from: &ValueSchema, decode: Transform, encode: Transform) -> Self {
        self.link(from, decode, encode, ("Transform", "Transform"), false)
    }

    /// `from.pipe(Schema.decodeTo(self))` with a passthrough transformation.
    pub fn decode_from_passthrough(&self, from: &ValueSchema) -> Self {
        self.link(
            from,
            Arc::new(Ok),
            Arc::new(Ok),
            ("Passthrough", "Passthrough"),
            false,
        )
    }

    /// Appends an encoding link, as Effect's `decodeTo` does.
    pub(crate) fn link(
        &self,
        from: &ValueSchema,
        decode: Transform,
        encode: Transform,
        getters: (&'static str, &'static str),
        json: bool,
    ) -> Self {
        let link = Link {
            from: from.clone(),
            decode,
            encode,
            getters,
            json,
        };
        self.map(|n| n.encoding.push(link))
    }

    /// `Schema.toType`: strips encodings recursively.
    pub fn to_type(&self) -> Self {
        let ast = self.map_children(Self::to_type);
        self.map(|n| {
            n.ast = ast;
            n.encoding.clear();
        })
    }

    /// `Schema.toEncoded`: follows encodings recursively.
    pub fn to_encoded(&self) -> Self {
        if let Some(link) = self.0.encoding.last() {
            let optional = self.0.optional;
            return link.from.to_encoded().map(|n| n.optional |= optional);
        }
        let ast = self.map_children(Self::to_encoded);
        self.map(|n| n.ast = ast)
    }

    fn map_children(&self, f: fn(&Self) -> Self) -> Ast {
        match &self.0.ast {
            Ast::Union(members) => Ast::Union(members.iter().map(f).collect()),
            Ast::Objects(fields) => {
                Ast::Objects(fields.iter().map(|(k, s)| (k.clone(), f(s))).collect())
            }
            Ast::Record(value) => Ast::Record(f(value)),
            Ast::Arrays { elements, rest } => Ast::Arrays {
                elements: elements.iter().map(f).collect(),
                rest: rest.as_ref().map(f),
            },
            Ast::Declaration(Declaration::Class(name, fields)) => {
                Ast::Declaration(Declaration::Class(name.clone(), f(fields)))
            }
            other => other.clone(),
        }
    }

    /// Property signatures of a struct (`Schema.getResolvedPropertySignatures`); empty for anything else.
    #[must_use]
    pub fn fields(&self) -> Vec<(String, ValueSchema)> {
        match &self.0.ast {
            Ast::Objects(fields) => fields.clone(),
            Ast::Declaration(Declaration::Class(_, fields)) => fields.fields(),
            _ => vec![],
        }
    }

    /// `Schema.decodeUnknownSync`.
    pub fn decode(&self, value: Val) -> Result<Val, SchemaError> {
        let mut value = value;
        for link in self.0.encoding.iter().rev() {
            value = (link.decode)(link.from.decode(value)?)?;
        }
        let out = self.parse(value, Self::decode)?;
        self.run_checks(&out)?;
        Ok(out)
    }

    /// `Schema.encodeUnknownSync`.
    pub fn encode(&self, value: Val) -> Result<Val, SchemaError> {
        self.run_checks(&value)?;
        let mut out = self.parse(value, Self::encode)?;
        for link in &self.0.encoding {
            out = link.from.encode((link.encode)(out)?)?;
        }
        Ok(out)
    }

    fn run_checks(&self, value: &Val) -> Result<(), SchemaError> {
        match self.0.checks.iter().find(|c| !(c.predicate)(value)) {
            Some(check) => Err(SchemaError(check.message.clone())),
            None => Ok(()),
        }
    }

    /// Structural validation of this node's own AST; children go through `child` (decode or encode).
    fn parse(
        &self,
        value: Val,
        child: fn(&Self, Val) -> Result<Val, SchemaError>,
    ) -> Result<Val, SchemaError> {
        let fail = |v: &Val| {
            Err(SchemaError(format!(
                "Expected {}, got {}",
                self.tag(),
                v.js_to_string()
            )))
        };
        match (&self.0.ast, value) {
            (Ast::Unknown | Ast::Any, v) => Ok(v),
            (Ast::String, v @ Val::String(_))
            | (Ast::Number, v @ Val::Number(_))
            | (Ast::Boolean, v @ Val::Bool(_))
            | (Ast::BigInt, v @ Val::BigInt(_))
            | (Ast::Symbol, v @ Val::Symbol(_))
            | (Ast::Null, v @ Val::Null)
            | (Ast::Undefined | Ast::Void, v @ Val::Undefined)
            | (Ast::Declaration(Declaration::Date), v @ Val::Date(_))
            | (Ast::Declaration(Declaration::Uint8Array), v @ Val::Bytes(_))
            | (Ast::Declaration(Declaration::Class(..)), v @ Val::Object(_)) => Ok(v),
            (Ast::Literal(l), v) if *l == v => Ok(v),
            (Ast::Enum(values), v) if values.iter().any(|(_, e)| *e == v) => Ok(v),
            (Ast::Union(members), v) => members
                .iter()
                .find_map(|m| child(m, v.clone()).ok())
                .map_or_else(|| fail(&v), Ok),
            (Ast::Objects(fields), Val::Object(mut obj)) => {
                let mut out = IndexMap::new();
                for (key, schema) in fields {
                    match obj.shift_remove(key) {
                        None if schema.is_optional() => {}
                        None => return Err(SchemaError(format!("Missing key \"{key}\""))),
                        Some(v) => {
                            out.insert(
                                key.clone(),
                                child(schema, v)
                                    .map_err(|e| SchemaError(format!("[\"{key}\"]: {e}")))?,
                            );
                        }
                    }
                }
                Ok(Val::Object(out))
            }
            (Ast::Record(value_schema), Val::Object(obj)) => obj
                .into_iter()
                .map(|(k, v)| Ok((k, child(value_schema, v)?)))
                .collect::<Result<_, _>>()
                .map(Val::Object),
            (Ast::Arrays { elements, rest }, Val::Array(items)) => {
                if items.len() < elements.len() || (rest.is_none() && items.len() > elements.len())
                {
                    return fail(&Val::Array(items));
                }
                let schemas = elements
                    .iter()
                    .chain(std::iter::repeat_n(rest.as_ref(), items.len()).flatten());
                items
                    .into_iter()
                    .zip(schemas)
                    .map(|(v, s)| child(s, v))
                    .collect::<Result<_, _>>()
                    .map(Val::Array)
            }
            (Ast::Suspend(_, f), v) => child(&f(), v),
            (_, v) => fail(&v),
        }
    }
}

impl fmt::Debug for ValueSchema {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ValueSchema({})", self.tag())
    }
}

impl Check {
    pub fn new(
        message: impl Into<String>,
        predicate: impl Fn(&Val) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            representation: None,
            annotations: Value::Null,
            message: message.into(),
            predicate: Arc::new(predicate),
        }
    }

    /// Effect's annotations for a built-in check; `representation` is its `representation.id`.
    fn effect(mut self, representation: &'static str, annotations: Value) -> Self {
        self.representation = Some(representation);
        self.annotations = annotations;
        self
    }
}

#[must_use]
pub fn string() -> ValueSchema {
    ValueSchema::new(Ast::String)
}

/// `Schema.Number` (allows `NaN`/`Infinity`, like `SqliteReal`).
#[must_use]
pub fn number() -> ValueSchema {
    ValueSchema::new(Ast::Number)
}

#[must_use]
pub fn finite() -> ValueSchema {
    number().check(is_finite())
}

#[must_use]
pub fn int() -> ValueSchema {
    number().check(is_int())
}

#[must_use]
pub fn boolean() -> ValueSchema {
    ValueSchema::new(Ast::Boolean)
}

#[must_use]
pub fn bigint() -> ValueSchema {
    ValueSchema::new(Ast::BigInt)
}

#[must_use]
pub fn symbol() -> ValueSchema {
    ValueSchema::new(Ast::Symbol)
}

#[must_use]
pub fn null() -> ValueSchema {
    ValueSchema::new(Ast::Null)
}

#[must_use]
pub fn undefined() -> ValueSchema {
    ValueSchema::new(Ast::Undefined)
}

#[must_use]
pub fn void() -> ValueSchema {
    ValueSchema::new(Ast::Void)
}

#[must_use]
pub fn unknown() -> ValueSchema {
    ValueSchema::new(Ast::Unknown)
}

#[must_use]
pub fn any() -> ValueSchema {
    ValueSchema::new(Ast::Any)
}

pub fn literal(value: impl Into<Val>) -> ValueSchema {
    ValueSchema::new(Ast::Literal(value.into()))
}

pub fn literals<V: Into<Val>>(values: impl IntoIterator<Item = V>) -> ValueSchema {
    union(values.into_iter().map(literal))
}

/// `Schema.Enum({ KEY: value, ... })`.
pub fn enums<V: Into<Val>>(values: impl IntoIterator<Item = (&'static str, V)>) -> ValueSchema {
    ValueSchema::new(Ast::Enum(
        values
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.into()))
            .collect(),
    ))
}

pub fn union(members: impl IntoIterator<Item = ValueSchema>) -> ValueSchema {
    ValueSchema::new(Ast::Union(members.into_iter().collect()))
}

#[must_use]
pub fn null_or(schema: ValueSchema) -> ValueSchema {
    union([schema, null()])
}

#[must_use]
pub fn undefined_or(schema: ValueSchema) -> ValueSchema {
    union([schema, undefined()])
}

/// `Schema.optional(schema)`: `schema | undefined` behind an optional key.
#[must_use]
pub fn optional(schema: ValueSchema) -> ValueSchema {
    undefined_or(schema).map(|n| n.optional = true)
}

/// Marks a schema as an optional key without adding `undefined`.
#[must_use]
pub fn optional_key(schema: ValueSchema) -> ValueSchema {
    schema.map(|n| n.optional = true)
}

pub fn struct_<K: Into<String>>(fields: impl IntoIterator<Item = (K, ValueSchema)>) -> ValueSchema {
    ValueSchema::new(Ast::Objects(
        fields.into_iter().map(|(k, s)| (k.into(), s)).collect(),
    ))
}

pub fn tagged_struct(
    tag: &str,
    fields: impl IntoIterator<Item = (&'static str, ValueSchema)>,
) -> ValueSchema {
    struct_([("_tag", literal(tag))].into_iter().chain(fields))
}

#[must_use]
pub fn array(item: ValueSchema) -> ValueSchema {
    ValueSchema::new(Ast::Arrays {
        elements: vec![],
        rest: Some(item),
    })
}

pub fn tuple(elements: impl IntoIterator<Item = ValueSchema>) -> ValueSchema {
    ValueSchema::new(Ast::Arrays {
        elements: elements.into_iter().collect(),
        rest: None,
    })
}

/// `Schema.Record(Schema.String, value)`.
#[must_use]
pub fn record(value: ValueSchema) -> ValueSchema {
    ValueSchema::new(Ast::Record(value))
}

pub fn suspend<F: Fn() -> ValueSchema + Send + Sync + 'static>(f: F) -> ValueSchema {
    ValueSchema::new(Ast::Suspend(std::any::type_name::<F>(), Arc::new(f)))
}

/// `Schema.Class<Self>(name)(fields)`.
pub fn class(name: &str, fields: ValueSchema) -> ValueSchema {
    ValueSchema::new(Ast::Declaration(Declaration::Class(
        name.into(),
        fields.clone(),
    )))
    .identifier(name)
    .annotate("~sentinels", Annotation::Json(json!([])))
    .link(
        &fields,
        Arc::new(Ok),
        Arc::new(Ok),
        ("Transform", "Passthrough"),
        false,
    )
}

#[must_use]
pub fn date() -> ValueSchema {
    ValueSchema::new(Ast::Declaration(Declaration::Date))
        .annotate(
            "representation",
            Annotation::Json(json!({ "id": DATE_REPRESENTATION, "payload": null })),
        )
        .expected("a valid Date")
}

#[must_use]
pub fn uint8array() -> ValueSchema {
    ValueSchema::new(Ast::Declaration(Declaration::Uint8Array))
        .annotate(
            "representation",
            Annotation::Json(json!({ "id": UINT8ARRAY_REPRESENTATION, "payload": null })),
        )
        .expected("Uint8Array")
}

#[must_use]
pub fn date_from_string() -> ValueSchema {
    date().decode_from(
        &string().expected("a string that will be decoded as a Date"),
        Arc::new(|v| {
            Ok(Val::Date(
                v.as_str()
                    .and_then(date_from_iso_string)
                    .map_or(f64::NAN, |ms| ms as f64),
            ))
        }),
        Arc::new(|v| match v {
            Val::Date(ms) if ms.is_finite() => Ok(Val::String(iso_string_from_millis(ms as i64))),
            other => Err(SchemaError(format!(
                "Invalid date {}",
                other.js_to_string()
            ))),
        }),
    )
}

/// `Schema.DateFromMillis`: integer epoch millis.
#[must_use]
pub fn date_from_millis() -> ValueSchema {
    date().decode_from(
        &int(),
        Arc::new(|v| match v {
            Val::Number(ms) => Ok(Val::Date(ms)),
            other => Ok(other),
        }),
        Arc::new(|v| match v {
            Val::Date(ms) => Ok(Val::Number(ms)),
            other => Ok(other),
        }),
    )
}

#[must_use]
pub fn uint8array_from_base64() -> ValueSchema {
    use base64::engine::general_purpose::STANDARD as engine;
    let from = string()
        .expected("a base64 encoded string that will be decoded as Uint8Array")
        .annotate("format", Annotation::Str("byte".into()))
        .annotate("contentEncoding", Annotation::Str("base64".into()));
    uint8array().link(
        &from,
        Arc::new(|v| {
            engine
                .decode(v.as_str().unwrap_or_default())
                .map(Val::Bytes)
                .map_err(|e| SchemaError(e.to_string()))
        }),
        Arc::new(|v| match v {
            Val::Bytes(b) => Ok(Val::String(engine.encode(b))),
            other => Ok(other),
        }),
        ("TransformEffect", "Transform"),
        false,
    )
}

#[must_use]
pub fn finite_from_string() -> ValueSchema {
    finite().decode_from(
        &string().expected("a string that will be decoded as a finite number"),
        Arc::new(|v| {
            let s = v.as_str().unwrap_or_default().trim().to_string();
            Ok(Val::Number(if s.is_empty() {
                f64::NAN
            } else {
                s.parse().unwrap_or(f64::NAN)
            }))
        }),
        Arc::new(|v| Ok(Val::String(v.js_to_string()))),
    )
}

/// `Schema.BooleanFromBit`: `0 | 1` ↔ `boolean`.
#[must_use]
pub fn boolean_from_bit() -> ValueSchema {
    boolean().decode_from(
        &literals([0, 1]),
        Arc::new(|v| Ok(Val::Bool(v == Val::Number(1.0)))),
        Arc::new(|v| Ok(Val::Number(if v == Val::Bool(true) { 1.0 } else { 0.0 }))),
    )
}

#[must_use]
pub fn non_empty_string() -> ValueSchema {
    string().check(is_min_length(1))
}

/// `Schema.Trim`: trims on decode, requires trimmed input on encode.
pub fn trim() -> ValueSchema {
    let trimmed = Check::new("Expected a string with no leading or trailing whitespace", |v| v.as_str().is_some_and(|s| s.trim() == s)).effect(
        "effect/schema/isTrimmed",
        json!({
            "expected": "a string with no leading or trailing whitespace",
            "representation": { "id": "effect/schema/isTrimmed", "payload": null },
            "arbitraryConstraint": { "patterns": [{ "source": "^\\S[\\s\\S]*\\S$|^\\S$|^$", "flags": "" }] }
        }),
    );
    string().check(trimmed).link(
        &string().expected("a string that will be decoded as a trimmed string"),
        Arc::new(|v| Ok(Val::String(v.as_str().unwrap_or_default().trim().into()))),
        Arc::new(Ok),
        ("Transform", "Passthrough"),
        false,
    )
}

/// `Schema.fromJsonString(schema)`.
#[must_use]
pub fn from_json_string(schema: ValueSchema) -> ValueSchema {
    schema.link(
        &string().expected("a string that will be decoded as JSON"),
        Arc::new(|v| Val::parse_json(v.as_str().unwrap_or_default())),
        Arc::new(|v| {
            v.to_json_string()
                .map(Val::String)
                .ok_or_else(|| SchemaError("JSON.stringify returned undefined".into()))
        }),
        ("TransformEffect", "TransformEffect"),
        true,
    )
}

#[must_use]
pub fn is_finite() -> Check {
    Check::new(
        "Expected a finite number",
        |v| matches!(v, Val::Number(n) if n.is_finite()),
    )
    .effect(
        "effect/schema/isFinite",
        json!({
            "expected": "a finite number",
            "representation": { "id": "effect/schema/isFinite", "payload": null },
            "arbitraryConstraint": { "number": "finite" }
        }),
    )
}

#[must_use]
pub fn is_int() -> Check {
    Check::new(
        "Expected an integer",
        |v| matches!(v, Val::Number(n) if n.fract() == 0.0),
    )
    .effect(
        IS_INT,
        json!({
            "expected": "an integer",
            "representation": { "id": IS_INT, "payload": null },
            "arbitraryConstraint": { "number": "integer" }
        }),
    )
}

#[must_use]
pub fn is_greater_than_or_equal_to(min: f64) -> Check {
    Check::new(format!("Expected a value greater than or equal to {min}"), move |v| matches!(v, Val::Number(n) if *n >= min)).effect(
        "effect/schema/isGreaterThanOrEqualTo",
        json!({
            "expected": format!("a value greater than or equal to {}", Val::Number(min).js_to_string()),
            "arbitraryConstraint": { "minimum": min },
            "representation": { "id": "effect/schema/isGreaterThanOrEqualTo", "payload": { "minimum": min } }
        }),
    )
}

#[must_use]
pub fn is_between(min: f64, max: f64) -> Check {
    Check::new(format!("Expected a value between {min} and {max}"), move |v| matches!(v, Val::Number(n) if *n >= min && *n <= max)).effect(
        "effect/schema/isBetween",
        json!({
            "expected": format!("a value between {} and {}", Val::Number(min).js_to_string(), Val::Number(max).js_to_string()),
            "arbitraryConstraint": { "minimum": min, "maximum": max },
            "representation": { "id": "effect/schema/isBetween", "payload": { "minimum": min, "maximum": max } }
        }),
    )
}

#[must_use]
pub fn is_min_length(min: usize) -> Check {
    Check::new(format!("Expected a value with a length of at least {min}"), move |v| match v {
        Val::String(s) => s.encode_utf16().count() >= min,
        Val::Array(a) => a.len() >= min,
        _ => false,
    })
    .effect(
        "effect/schema/isMinLength",
        json!({
            "expected": format!("a value with a length of at least {min}"),
            "representation": { "id": "effect/schema/isMinLength", "payload": { "minLength": min } },
            "~structural": true,
            "arbitraryConstraint": { "minLength": min }
        }),
    )
}

#[must_use]
pub fn is_pattern(pattern: &str) -> Check {
    let re = regex::Regex::new(pattern).expect("valid pattern");
    Check::new(format!("Expected a string matching the RegExp {pattern}"), move |v| v.as_str().is_some_and(|s| re.is_match(s))).effect(
        "effect/schema/isPattern",
        json!({
            "expected": format!("a string matching the RegExp {pattern}"),
            "representation": { "id": "effect/schema/isPattern", "payload": { "source": pattern, "flags": "" } },
            "arbitraryConstraint": { "patterns": [{ "source": pattern, "flags": "" }] }
        }),
    )
}

#[must_use]
pub fn is_uuid() -> Check {
    const SOURCE: &str = "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$";
    regex_check(SOURCE, "a UUID").effect(
        "effect/schema/isUUID",
        json!({
            "expected": "a UUID",
            "representation": { "id": "effect/schema/isUUID", "payload": { "version": null } },
            "arbitraryConstraint": { "patterns": [{ "source": SOURCE, "flags": "" }] }
        }),
    )
}

#[must_use]
pub fn is_ulid() -> Check {
    const SOURCE: &str = "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$";
    let expected = format!("a string matching the RegExp {SOURCE}");
    regex_check(SOURCE, &expected).effect(
        "effect/schema/isULID",
        json!({
            "expected": expected,
            "representation": { "id": "effect/schema/isULID", "payload": null },
            "arbitraryConstraint": { "patterns": [{ "source": SOURCE, "flags": "u" }] }
        }),
    )
}

fn regex_check(source: &str, expected: &str) -> Check {
    let re = regex::Regex::new(source).expect("valid pattern");
    Check::new(format!("Expected {expected}"), move |v| {
        v.as_str().is_some_and(|s| re.is_match(s))
    })
}

#[must_use]
pub fn is_greater_than_date(ms: f64) -> Check {
    let at = iso_string_from_millis(ms as i64);
    Check::new(format!("Expected a date after {at}"), move |v| matches!(v, Val::Date(d) if *d > ms)).effect(
        "effect/schema/isGreaterThanDate",
        json!({
            "expected": format!("a value greater than {at}"),
            "arbitraryConstraint": { "minimum": at, "exclusiveMinimum": true },
            "representation": { "id": "effect/schema/isGreaterThanDate", "payload": { "exclusiveMinimum": at } }
        }),
    )
}

/// `Schema.makeFilter(predicate)`.
pub fn make_filter(
    message: &str,
    predicate: impl Fn(&Val) -> bool + Send + Sync + 'static,
) -> Check {
    Check::new(message, predicate)
}

impl Val {
    pub fn obj<K: Into<String>>(entries: impl IntoIterator<Item = (K, Val)>) -> Self {
        Val::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::String(s) => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_object(&self) -> Option<&IndexMap<String, Val>> {
        match self {
            Val::Object(o) => Some(o),
            _ => None,
        }
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Val> {
        self.as_object()?.get(key)
    }

    /// JSON form of a JSON-compatible value (`undefined`, symbols and bigints become `null`).
    #[must_use]
    pub fn to_json_value(&self) -> Value {
        self.to_json_string()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    }

    /// `JSON.parse`.
    pub fn parse_json(s: &str) -> Result<Val, SchemaError> {
        serde_json::from_str::<Value>(s)
            .map(Val::from)
            .map_err(|e| SchemaError(e.to_string()))
    }

    /// `JSON.stringify`; `None` where JS returns `undefined`.
    #[must_use]
    pub fn to_json_string(&self) -> Option<String> {
        Some(match self {
            Val::Undefined | Val::Symbol(_) => return None,
            Val::Null => "null".into(),
            Val::Bool(b) => b.to_string(),
            Val::Number(n) if n.is_finite() => js_number(*n),
            Val::Number(_) => "null".into(),
            Val::BigInt(_) => return None,
            Val::String(s) => Value::String(s.clone()).to_string(),
            Val::Date(ms) if ms.is_finite() => {
                format!("\"{}\"", iso_string_from_millis(*ms as i64))
            }
            Val::Date(_) => "null".into(),
            Val::Bytes(b) => Val::obj(
                b.iter()
                    .enumerate()
                    .map(|(i, x)| (i.to_string(), Val::Number(f64::from(*x)))),
            )
            .to_json_string()?,
            Val::Array(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(|v| v.to_json_string().unwrap_or_else(|| "null".into()))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Val::Object(obj) => {
                let entries: Vec<String> = obj
                    .iter()
                    .filter_map(|(k, v)| {
                        Some(format!(
                            "{}:{}",
                            Value::String(k.clone()),
                            v.to_json_string()?
                        ))
                    })
                    .collect();
                format!("{{{}}}", entries.join(","))
            }
        })
    }

    /// `String(value)`, as template literals interpolate it.
    pub fn js_to_string(&self) -> String {
        match self {
            Val::Undefined => "undefined".into(),
            Val::Null => "null".into(),
            Val::Bool(b) => b.to_string(),
            Val::Number(n) => js_number(*n),
            Val::BigInt(n) => n.to_string(),
            Val::String(s) => s.clone(),
            Val::Symbol(s) => format!("Symbol({s})"),
            Val::Date(ms) => iso_string_from_millis(*ms as i64),
            Val::Bytes(b) => b.iter().map(u8::to_string).collect::<Vec<_>>().join(","),
            Val::Array(items) => items
                .iter()
                .map(Val::js_to_string)
                .collect::<Vec<_>>()
                .join(","),
            Val::Object(_) => "[object Object]".into(),
        }
    }
}

impl From<Value> for Val {
    fn from(v: Value) -> Self {
        match v {
            Value::Null => Val::Null,
            Value::Bool(b) => Val::Bool(b),
            Value::Number(n) => Val::Number(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => Val::String(s),
            Value::Array(a) => Val::Array(a.into_iter().map(Val::from).collect()),
            Value::Object(o) => {
                Val::Object(o.into_iter().map(|(k, v)| (k, Val::from(v))).collect())
            }
        }
    }
}

impl From<&str> for Val {
    fn from(v: &str) -> Self {
        Val::String(v.into())
    }
}

impl From<String> for Val {
    fn from(v: String) -> Self {
        Val::String(v)
    }
}

impl From<bool> for Val {
    fn from(v: bool) -> Self {
        Val::Bool(v)
    }
}

impl From<f64> for Val {
    fn from(v: f64) -> Self {
        Val::Number(v)
    }
}

impl From<i32> for Val {
    fn from(v: i32) -> Self {
        Val::Number(f64::from(v))
    }
}

impl From<i64> for Val {
    fn from(v: i64) -> Self {
        Val::Number(v as f64)
    }
}

/// `Number.prototype.toString` for the ranges the DSL meets.
fn js_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if n == 0.0 {
        "0".into()
    } else {
        n.to_string()
    }
}
