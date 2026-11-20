//! Prints this build's SQLite in the shape of `scripts/dump-wa-sqlite-build.ts` output (used by scripts/check-sqlite-build.sh).
use rusqlite::{Connection, types::Value};
use serde_json::{Map, Value as Json, json};

const PRAGMAS: &[&str] = &[
    "foreign_keys",
    "recursive_triggers",
    "automatic_index",
    "cache_size",
    "page_size",
    "journal_mode",
    "synchronous",
    "temp_store",
    "secure_delete",
    "cell_size_check",
    "defer_foreign_keys",
    "trusted_schema",
    "legacy_alter_table",
    "reverse_unordered_selects",
    "case_sensitive_like",
    "ignore_check_constraints",
    "query_only",
    "auto_vacuum",
    "encoding",
    "busy_timeout",
    "max_page_count",
    "wal_autocheckpoint",
    "threads",
    "hard_heap_limit",
    "soft_heap_limit",
    "mmap_size",
    "locking_mode",
    "cache_spill",
    "analysis_limit",
];

const PROBES: &[(&str, &str)] = &[
    ("fts5", "create virtual table t_fts5 using fts5(a)"),
    (
        "rtree",
        "create virtual table t_rtree using rtree(id, x0, x1)",
    ),
    ("dqsSelect", r#"select "x""#),
    ("likeBlob", "select X'00' like '%'"),
    ("json", r#"select json('{"a":1}')"#),
    ("jsonb", "select typeof(jsonb('{}'))"),
    ("dbstat", "select count(*) >= 0 from dbstat"),
    ("bytecode", "select count(*) > 0 from bytecode('select 1')"),
    ("loadExtension", "select load_extension('x')"),
];

fn main() {
    let db = Connection::open_in_memory().unwrap();
    let rows = |sql: &str| -> rusqlite::Result<Vec<Json>> {
        let mut stmt = db.prepare(sql)?;
        stmt.query_map([], |r| r.get::<_, Value>(0))
            .and_then(|it| it.map(|v| v.map(to_json)).collect())
    };
    let scalar = |sql: &str| rows(sql).map(|r| r.into_iter().next().unwrap_or(Json::Null));
    let probes: Map<_, _> = PROBES
        .iter()
        .map(|(name, sql)| {
            let result = match scalar(sql) {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(e) => json!({ "ok": false, "error": sqlite_message(&e) }),
            };
            (name.to_string(), result)
        })
        .collect();
    let out = json!({
        "version": scalar("select sqlite_version()").unwrap(),
        "sourceId": scalar("select sqlite_source_id()").unwrap(),
        "compileOptions": rows("pragma compile_options").unwrap(),
        "pragmas": PRAGMAS.iter().map(|p| (p.to_string(), scalar(&format!("pragma {p}")).unwrap())).collect::<Map<_, _>>(),
        "modules": rows("select name from pragma_module_list order by name").unwrap(),
        "functions": rows("select distinct name from pragma_function_list order by name").unwrap(),
        "probes": probes,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

fn to_json(v: Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Integer(i) => i.into(),
        Value::Real(f) => f.into(),
        Value::Text(s) => s.into(),
        Value::Blob(b) => format!("{b:?}").into(),
    }
}

fn sqlite_message(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(msg))
        | rusqlite::Error::SqlInputError { msg, .. } => msg.clone(),
        other => other.to_string(),
    }
}
