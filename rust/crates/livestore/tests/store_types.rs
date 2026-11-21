//! Port of `packages/@livestore/livestore/src/store/store-types.test.ts`. `isQueryable` is a runtime
//! type guard in TS; in Rust "queryable" is the [`Queryable`] trait, so the checks resolve at compile time.

use std::marker::PhantomData;
use std::sync::Arc;

use livestore::live_queries::LiveQuery;
use livestore::{DbQueryDef, QueryInput, Queryable, SignalDef, query_db, signal};
use livestore_schema::query_builder::Select;
use livestore_sqlite::Row;
use serde_json::Value;

/// `Probe::<T>::IS` picks the inherent const when `T: Queryable`, else the trait fallback (`false`).
struct Probe<T>(PhantomData<T>);

trait NotQueryable {
    const IS: bool = false;
}

impl<T> NotQueryable for Probe<T> {}

impl<T: Queryable> Probe<T> {
    const IS: bool = true;
}

#[test]
fn identifies_live_query_definitions() {
    let _def: DbQueryDef<Vec<Row>> = query_db(QueryInput::sql("select 1 as value"));
    const { assert!(Probe::<DbQueryDef<Vec<Row>>>::IS) };
}

#[test]
fn identifies_signal_definitions() {
    let _sig = signal(0i64, Some("count"));
    const { assert!(Probe::<SignalDef<i64>>::IS) };
}

#[test]
fn identifies_live_query_instances() {
    const { assert!(Probe::<Arc<LiveQuery<Value>>>::IS) };
}

#[test]
fn identifies_query_builders() {
    const { assert!(Probe::<Select<'static>>::IS) };
}

#[test]
fn rejects_unrelated_values() {
    const { assert!(!Probe::<()>::IS) };
    const { assert!(!Probe::<Option<Value>>::IS) };
    const { assert!(!Probe::<Value>::IS) };
}
