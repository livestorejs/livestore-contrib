//! The args schema of a Rust type, used by `#[derive(Event)]` for each field.

use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;

use serde_json::Value;

use crate::event_def::DateFromString;
use crate::value_schema::{self as s, ValueSchema};

/// A Rust type with a known args schema.
pub trait SchemaType {
    fn schema() -> ValueSchema;
}

macro_rules! schema_type {
    ($schema:expr => $($ty:ty),+) => {
        $(impl SchemaType for $ty {
            fn schema() -> ValueSchema {
                $schema
            }
        })+
    };
}

schema_type!(s::string() => String);
schema_type!(s::boolean() => bool);
schema_type!(s::number() => f32, f64);
schema_type!(s::int() => i8, i16, i32, i64, u8, u16, u32, u64, isize, usize);
schema_type!(s::date_from_string() => DateFromString);
schema_type!(s::unknown() => Value);

/// `None` encodes as `null`, like `Schema.NullOr`.
impl<T: SchemaType> SchemaType for Option<T> {
    fn schema() -> ValueSchema {
        s::null_or(T::schema())
    }
}

impl<T: SchemaType> SchemaType for Vec<T> {
    fn schema() -> ValueSchema {
        s::array(T::schema())
    }
}

impl<T: SchemaType, H: BuildHasher> SchemaType for HashMap<String, T, H> {
    fn schema() -> ValueSchema {
        s::record(T::schema())
    }
}

impl<T: SchemaType> SchemaType for BTreeMap<String, T> {
    fn schema() -> ValueSchema {
        s::record(T::schema())
    }
}
