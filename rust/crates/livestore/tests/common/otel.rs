//! `utils/tests/otel.ts`: a `tracing` layer standing in for the in-memory span exporter, the simplified span
//! trees the TS tests snapshot, and pretty-format rendering to compare them with the TS `.snap` files.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::DefaultGuard;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{Layer, Registry};

/// Collects every span; like the exporter, only closed spans count, in the order they closed.
#[derive(Clone, Default)]
pub struct SpanCapture {
    spans: Arc<Mutex<Spans>>,
}

#[derive(Default)]
struct Spans {
    all: Vec<SpanData>,
    closed: usize,
}

struct SpanData {
    name: String,
    attributes: Map<String, Value>,
    parent: Option<usize>,
    closed_at: Option<usize>,
}

struct Index(usize);

/// Installs a capture as this thread's subscriber (the tests run on a current-thread runtime).
pub fn capture() -> (SpanCapture, DefaultGuard) {
    let capture = SpanCapture::default();
    let guard = tracing::subscriber::set_default(Registry::default().with(capture.clone()));
    (capture, guard)
}

impl SpanCapture {
    /// Yields until `count` spans named `name` closed.
    pub async fn closed(&self, name: &str, count: usize) {
        while self
            .spans
            .lock()
            .unwrap()
            .all
            .iter()
            .filter(|s| s.name == name && s.closed_at.is_some())
            .count()
            < count
        {
            tokio::task::yield_now().await;
        }
    }

    /// `getSimplifiedRootSpan`.
    pub fn root_span(&self, name: &str, map_attributes: impl Fn(&str, Value) -> Value) -> Value {
        self.root_spans(name, map_attributes)
            .into_iter()
            .next()
            .unwrap_or_else(|| panic!("Could not find the root span named '{name}'."))
    }

    /// `getAllSimplifiedRootSpans`.
    pub fn root_spans(
        &self,
        name: &str,
        map_attributes: impl Fn(&str, Value) -> Value,
    ) -> Vec<Value> {
        let spans = self.spans.lock().unwrap();
        let mut finished: Vec<usize> = (0..spans.all.len())
            .filter(|i| spans.all[*i].closed_at.is_some())
            .collect();
        finished.sort_by_key(|i| spans.all[*i].closed_at);
        let roots: Vec<usize> = finished
            .iter()
            .copied()
            .filter(|i| spans.all[*i].name == name)
            .collect();
        assert!(
            !roots.is_empty(),
            "Could not find any root spans named '{name}'"
        );
        roots
            .into_iter()
            .map(|i| simplify(&spans.all, &finished, i, &map_attributes))
            .collect()
    }
}

fn simplify(
    all: &[SpanData],
    finished: &[usize],
    i: usize,
    map_attributes: &impl Fn(&str, Value) -> Value,
) -> Value {
    let span = &all[i];
    let attributes: Map<String, Value> = span
        .attributes
        .iter()
        .map(|(k, v)| (k.clone(), map_attributes(k, v.clone())))
        .collect();
    let children: Vec<Value> = finished
        .iter()
        .filter(|c| all[**c].parent == Some(i) && all[**c].name != "createStore:makeAdapter")
        .map(|c| simplify(all, finished, *c, map_attributes))
        .collect();
    let mut out = Map::new();
    out.insert("_name".into(), span.name.clone().into());
    if !attributes.is_empty() {
        out.insert("attributes".into(), attributes.into());
    }
    if !children.is_empty() {
        out.insert("children".into(), children.into());
    }
    out.into()
}

impl<S: tracing::Subscriber + for<'a> LookupSpan<'a>> Layer<S> for SpanCapture {
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("new span");
        let parent = span
            .parent()
            .and_then(|p| p.extensions().get::<Index>().map(|i| i.0));
        let mut data = SpanData {
            name: attrs.metadata().name().into(),
            attributes: Map::new(),
            parent,
            closed_at: None,
        };
        attrs.record(&mut Visitor(&mut data));
        let mut spans = self.spans.lock().unwrap();
        spans.all.push(data);
        span.extensions_mut().insert(Index(spans.all.len() - 1));
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        let Some(Index(i)) = ctx
            .span(id)
            .and_then(|s| s.extensions().get::<Index>().map(|i| Index(i.0)))
        else {
            return;
        };
        values.record(&mut Visitor(&mut self.spans.lock().unwrap().all[i]));
    }

    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        let Some(Index(i)) = ctx
            .span(&id)
            .and_then(|s| s.extensions().get::<Index>().map(|i| Index(i.0)))
        else {
            return;
        };
        let mut spans = self.spans.lock().unwrap();
        spans.closed += 1;
        spans.all[i].closed_at = Some(spans.closed);
    }
}

/// Attribute values as OTel keeps them; `otel.name` renames the span (`span.updateName`).
struct Visitor<'a>(&'a mut SpanData);

impl Visitor<'_> {
    fn set(&mut self, field: &Field, value: Value) {
        match field.name() {
            "otel.name" => self.0.name = value.as_str().unwrap_or_default().into(),
            name => _ = self.0.attributes.insert(name.into(), value),
        }
    }
}

impl Visit for Visitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.set(field, value.into());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.set(field, value.into());
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.set(field, value.into());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.set(field, value.into());
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.set(field, value.into());
    }

    /// Arrays are recorded with `?`: their debug form is JSON.
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let text = format!("{value:?}");
        self.set(
            field,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        );
    }
}

/// Orders the children of the span named `parent` like they appear in `expected` (a TS snapshot). For spans of
/// concurrent fibers, whose finish order depends on the scheduler; any other difference still fails the comparison.
pub fn order_children_like(tree: &mut Value, parent: &str, expected: &str) {
    let marker = format!("\"_name\": \"{parent}\",");
    let Some(line) = expected.lines().position(|l| l.trim() == marker) else {
        return;
    };
    let lines: Vec<&str> = expected.lines().collect();
    let indent = lines[line].len() - lines[line].trim_start().len();
    let order: Vec<String> = lines[line + 1..]
        .iter()
        .take_while(|l| l.len() - l.trim_start().len() >= indent)
        .filter(|l| l.len() - l.trim_start().len() == indent + 4)
        .filter_map(|l| {
            l.trim()
                .strip_prefix("\"_name\": \"")?
                .strip_suffix("\",")
                .map(String::from)
        })
        .collect();
    reorder(tree, parent, &order);
}

fn reorder(tree: &mut Value, parent: &str, order: &[String]) {
    let is_parent = tree["_name"] == parent;
    let Some(children) = tree.get_mut("children").and_then(Value::as_array_mut) else {
        return;
    };
    if !is_parent {
        children.iter_mut().for_each(|c| reorder(c, parent, order));
        return;
    }
    let mut rest = std::mem::take(children);
    for name in order {
        if let Some(i) = rest.iter().position(|c| c["_name"] == name.as_str()) {
            children.push(rest.remove(i));
        }
    }
    children.extend(rest);
}

/// The `mapAttributes` of `db-query.test.ts`.
pub fn map_attributes(key: &str, value: Value) -> Value {
    match (key, value) {
        ("code.stacktrace", _) => "<STACKTRACE>".into(),
        ("sql.query", Value::String(s)) => normalize_savepoints(&s).into(),
        (_, v) => v,
    }
}

fn normalize_savepoints(sql: &str) -> String {
    let mut out = String::new();
    let mut rest = sql;
    while let Some(i) = rest.find("livestore_savepoint_") {
        let after = &rest[i + "livestore_savepoint_".len()..];
        let digits = after.chars().take_while(char::is_ascii_digit).count();
        out.push_str(&rest[..i]);
        out.push_str(if digits > 0 {
            "livestore_savepoint_<id>"
        } else {
            "livestore_savepoint_"
        });
        rest = &after[digits..];
    }
    out + rest
}

/// Vitest's pretty-format: sorted keys, two-space indent, trailing commas, unescaped strings.
pub fn pretty(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, indent: usize, out: &mut String) {
    let pad = "  ".repeat(indent + 1);
    match value {
        Value::Object(map) if !map.is_empty() => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push_str("{\n");
            for key in keys {
                out.push_str(&format!("{pad}\"{key}\": "));
                write_pretty(&map[key], indent + 1, out);
                out.push_str(",\n");
            }
            out.push_str(&"  ".repeat(indent));
            out.push('}');
        }
        Value::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            for item in items {
                out.push_str(&pad);
                write_pretty(item, indent + 1, out);
                out.push_str(",\n");
            }
            out.push_str(&"  ".repeat(indent));
            out.push(']');
        }
        Value::Object(_) => out.push_str("{}"),
        Value::Array(_) => out.push_str("[]"),
        Value::String(s) => out.push_str(&format!("\"{s}\"")),
        other => out.push_str(&other.to_string()),
    }
}

/// One entry of a TS `.snap` file (path relative to the repository root).
pub fn ts_snapshot(file: &str, name: &str) -> String {
    let path = format!(
        "{}/../../../repos/livestore/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let start = format!("exports[`{name}`] = `\n");
    let from = text
        .find(&start)
        .unwrap_or_else(|| panic!("no snapshot `{name}` in {file}"))
        + start.len();
    let len = text[from..].find("\n`;\n").expect("snapshot end");
    text[from..from + len]
        .replace("\\`", "`")
        .replace("\\${", "${")
}
