//! Port of `packages/@livestore/livestore/src/live-queries/db-query.test.ts`. The Store's `tracing` spans are
//! captured like the TS in-memory exporter and compared with the TS file snapshots.

mod common;

use std::sync::{Arc, Mutex};

use common::otel::{
    SpanCapture, capture, map_attributes, order_children_like, pretty, ts_snapshot,
};
use common::todomvc::{TODOS, make_todo_mvc, todo, todo_created};
use futures::{FutureExt, StreamExt};
use livestore::reactive::{GraphSnapshot, NodeKind, SerializedNode};
use livestore::{QueryInput, SubscribeOptions, computed, query_db, query_db_fn};
use livestore_schema::query_builder::{Filter, First};
use livestore_sqlite::Row;
use serde_json::{Value, json};

fn default_todo() -> Value {
    todo("", "", false)
}

fn uncompleted_first() -> livestore_schema::query_builder::Select<'static> {
    TODOS
        .query()
        .where_eq("completed", json!(false))
        .first(First::Fallback(default_todo()))
}

/// `Schema.Array(tables.todos.rowSchema)`.
fn decode_todos(rows: Vec<Row>) -> Result<Value, String> {
    TODOS
        .query()
        .decode_result(&Value::Array(rows.into_iter().map(Value::Object).collect()))
        .map_err(|e| e.to_string())
}

const SNAPSHOTS: &str =
    "packages/@livestore/livestore/src/live-queries/__snapshots__/db-query.test.ts.snap";

/// The two span snapshots every test ends with: the `createStore` tree and all `LiveStore:commit` trees.
fn assert_spans(spans: &SpanCapture, create_store: &str, commits: &str) {
    assert_create_store(spans, &ts_snapshot(SNAPSHOTS, create_store));
    assert_eq!(
        pretty(&spans.root_spans("LiveStore:commit", map_attributes).into()),
        ts_snapshot(SNAPSHOTS, commits)
    );
}

/// The boot span's children are the push and pull fibers: their finish order is the scheduler's.
fn assert_create_store(spans: &SpanCapture, expected: &str) {
    let mut tree = spans.root_span("createStore", map_attributes);
    order_children_like(&mut tree, "client-session-sync-processor:boot", expected);
    assert_eq!(pretty(&tree), expected);
}

/// `reactivityGraph.getSnapshot({ includeResults: true })` in its TS shape.
fn ts_graph(snapshot: &GraphSnapshot) -> String {
    fn node(n: &SerializedNode) -> Value {
        let counter = match n.kind {
            NodeKind::Ref => "refreshes",
            NodeKind::Thunk => "recomputations",
            NodeKind::Effect => "invocations",
        };
        let mut v = json!({
            "_tag": n.kind.to_string(), "id": n.id, "isDestroyed": n.is_destroyed, "isDirty": n.is_dirty,
            counter: n.counter, "sub": n.sub, "super": n.sup,
        });
        for (key, value) in [
            ("label", n.label.clone().map(Value::from)),
            ("meta", n.meta.clone()),
        ] {
            if let Some(value) = value {
                v[key] = value;
            }
        }
        if let Some(result) = &n.previous_result {
            v["previousResult"] = json!({ "_tag": "Some", "value": result });
        }
        v
    }
    pretty(&json!({
        "atoms": snapshot.atoms.iter().map(node).collect::<Vec<_>>(),
        "effects": snapshot.effects.iter().map(node).collect::<Vec<_>>(),
        "deferredEffects": snapshot.deferred_effects,
    }))
}

fn collect<T: Send + 'static>() -> (Arc<Mutex<Vec<T>>>, impl Fn(T) + Send + Sync + 'static) {
    let results = Arc::new(Mutex::new(Vec::new()));
    let sink = results.clone();
    (results, move |v| sink.lock().unwrap().push(v))
}

#[tokio::test]
async fn otel() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let query = query_db(
        QueryInput::new("select * from todos", vec![], Arc::new(decode_todos))
            .queried_tables(&["todos"]),
    );
    assert_eq!(store.query(&query), json!([]));
    store
        .commit([todo_created("t1", "buy milk", false)])
        .unwrap();
    assert_eq!(store.query(&query), json!([todo("t1", "buy milk", false)]));
    store.close().await;
    assert_spans(&spans, "otel > otel 3", "otel > otel 4");
}

#[tokio::test]
async fn with_thunks() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let filter = computed(|_| "where completed = 0".to_string(), Some("where-filter"));
    let query = query_db_fn(move |get| {
        let decode = Arc::new(|rows: Vec<Row>| {
            decode_todos(rows).map(|v| {
                v.as_array()
                    .and_then(|a| a.first().cloned())
                    .unwrap_or_else(default_todo)
            })
        });
        QueryInput::new(
            &format!("select * from todos {}", get.get(&filter)),
            vec![],
            decode,
        )
    })
    .label("all todos");
    let graph = store.reactivity_graph();
    assert_eq!(
        ts_graph(&graph.snapshot(true)),
        ts_snapshot(SNAPSHOTS, "otel > with thunks 1")
    );
    assert_eq!(store.query(&query), default_todo());
    assert_eq!(
        ts_graph(&graph.snapshot(true)),
        ts_snapshot(SNAPSHOTS, "otel > with thunks 3")
    );
    store
        .commit([todo_created("t1", "buy milk", false)])
        .unwrap();
    assert_eq!(
        ts_graph(&graph.snapshot(true)),
        ts_snapshot(SNAPSHOTS, "otel > with thunks 4")
    );
    assert_eq!(store.query(&query), todo("t1", "buy milk", false));
    assert_eq!(
        ts_graph(&graph.snapshot(true)),
        ts_snapshot(SNAPSHOTS, "otel > with thunks 6")
    );
    store.close().await;
    assert_spans(&spans, "otel > with thunks 7", "otel > with thunks 8");
}

/// An unlabeled computed is named after its closure's type (TS: the function's source text).
#[tokio::test]
async fn with_thunks_with_query_builder_and_without_labels() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let filter = computed(|_| json!(false), None);
    let filter_label = filter.label.clone();
    let query = query_db_fn(move |get| {
        QueryInput::from(
            &TODOS
                .query()
                .where_eq("completed", get.get(&filter))
                .first(First::Fallback(default_todo())),
        )
    });
    assert_eq!(store.query(&query), default_todo());
    store
        .commit([todo_created("t1", "buy milk", false)])
        .unwrap();
    assert_eq!(store.query(&query), todo("t1", "buy milk", false));
    store.close().await;
    let expected = ts_snapshot(
        SNAPSHOTS,
        "otel > with thunks with query builder and without labels 3",
    )
    .replace(
        "js:() => ({ completed: false })",
        &format!("js:{filter_label}"),
    );
    assert_create_store(&spans, &expected);
    assert_eq!(
        pretty(&spans.root_spans("LiveStore:commit", map_attributes).into()),
        ts_snapshot(
            SNAPSHOTS,
            "otel > with thunks with query builder and without labels 4"
        )
    );
}

#[tokio::test]
async fn query_builder_subscription_basic_functionality() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let (results, push) = collect();
    let sub = store.subscribe(&uncompleted_first(), push, SubscribeOptions::default());
    assert_eq!(*results.lock().unwrap(), [default_todo()]);
    store
        .commit([todo_created("t1", "buy milk", false)])
        .unwrap();
    assert_eq!(
        *results.lock().unwrap(),
        [default_todo(), todo("t1", "buy milk", false)]
    );
    sub.unsubscribe();
    store.close().await;
    assert_spans(
        &spans,
        "otel > QueryBuilder subscription - basic functionality 1",
        "otel > QueryBuilder subscription - basic functionality 2",
    );
}

#[tokio::test]
async fn query_builder_subscription_skip_initial_run() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let (results, push) = collect();
    let sub = store.subscribe(
        &uncompleted_first(),
        push,
        SubscribeOptions {
            skip_initial_run: true,
            ..Default::default()
        },
    );
    assert!(results.lock().unwrap().is_empty());
    store
        .commit([todo_created("t-skip", "skip initial", false)])
        .unwrap();
    assert_eq!(
        *results.lock().unwrap(),
        [todo("t-skip", "skip initial", false)]
    );
    sub.unsubscribe();
    store.close().await;
    assert_spans(
        &spans,
        "otel > QueryBuilder subscription - skipInitialRun 1",
        "otel > QueryBuilder subscription - skipInitialRun 2",
    );
}

#[tokio::test]
async fn query_builder_subscription_unsubscribe_functionality() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let (results1, push1) = collect::<Value>();
    let (results2, push2) = collect::<Value>();
    let sub1 = store.subscribe(&uncompleted_first(), push1, SubscribeOptions::default());
    let sub2 = store.subscribe(&uncompleted_first(), push2, SubscribeOptions::default());
    assert_eq!(
        (
            results1.lock().unwrap().len(),
            results2.lock().unwrap().len()
        ),
        (1, 1)
    );
    store
        .commit([todo_created("t3", "read book", false)])
        .unwrap();
    assert_eq!(
        (
            results1.lock().unwrap().len(),
            results2.lock().unwrap().len()
        ),
        (2, 2)
    );
    sub1.unsubscribe();
    store
        .commit([todo_created("t4", "cook dinner", false)])
        .unwrap();
    assert_eq!(
        (
            results1.lock().unwrap().len(),
            results2.lock().unwrap().len()
        ),
        (2, 3)
    );
    sub2.unsubscribe();
    store.close().await;
    assert_spans(
        &spans,
        "otel > QueryBuilder subscription - unsubscribe functionality 1",
        "otel > QueryBuilder subscription - unsubscribe functionality 2",
    );
}

#[tokio::test]
async fn query_builder_subscription_async_iterator() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let mut iterator = store.subscribe_stream(&uncompleted_first(), SubscribeOptions::default());
    assert_eq!(iterator.next().await, Some(default_todo()));
    store
        .commit([todo_created("t-async", "write tests", false)])
        .unwrap();
    assert_eq!(
        iterator.next().await,
        Some(todo("t-async", "write tests", false))
    );
    drop(iterator);
    store.close().await;
    assert_spans(
        &spans,
        "otel > QueryBuilder subscription - async iterator 1",
        "otel > QueryBuilder subscription - async iterator 2",
    );
}

#[tokio::test]
async fn query_builder_subscription_async_iterator_with_skip_initial_run() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let mut iterator = store.subscribe_stream(
        &uncompleted_first(),
        SubscribeOptions {
            skip_initial_run: true,
            ..Default::default()
        },
    );
    assert_eq!(
        iterator.next().now_or_never(),
        None,
        "nothing before the first change"
    );
    store
        .commit([todo_created("t-async-skip", "write tests later", false)])
        .unwrap();
    assert_eq!(
        iterator.next().await,
        Some(todo("t-async-skip", "write tests later", false))
    );
    drop(iterator);
    store.close().await;
    assert_spans(
        &spans,
        "otel > QueryBuilder subscription - async iterator with skipInitialRun 1",
        "otel > QueryBuilder subscription - async iterator with skipInitialRun 2",
    );
}

#[tokio::test]
async fn query_builder_subscription_direct_table_subscription() {
    let (spans, _guard) = capture();
    let store = make_todo_mvc().await;
    let (results, push) = collect();
    let sub = store.subscribe(&*TODOS, push, SubscribeOptions::default());
    assert_eq!(*results.lock().unwrap(), [json!([])]);
    store
        .commit([todo_created("t5", "clean house", true)])
        .unwrap();
    assert_eq!(
        *results.lock().unwrap(),
        [json!([]), json!([todo("t5", "clean house", true)])]
    );
    sub.unsubscribe();
    store.close().await;
    assert_spans(
        &spans,
        "otel > QueryBuilder subscription - direct table subscription 1",
        "otel > QueryBuilder subscription - direct table subscription 2",
    );
}
