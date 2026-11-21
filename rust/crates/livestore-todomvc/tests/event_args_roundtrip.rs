//! Event arguments cross clients as JSON, so Rust must read what TypeScript writes and write what TypeScript
//! reads. The leader fixtures hold arguments that core's TypeScript leader encoded into its eventlog.

use livestore_schema::Event;
use livestore_schema::value_schema::Val;
use livestore_todomvc::{
    TodoClearedCompleted, TodoCompleted, TodoCreated, TodoDeleted, TodoUncompleted,
};
use serde_json::Value;

#[test]
fn event_args_round_trip_with_typescript() {
    let mut checked = 0;
    for (name, args) in ts_encoded_args() {
        match name.as_str() {
            "v1.TodoCreated" => round_trip::<TodoCreated>(&args),
            "v1.TodoCompleted" => round_trip::<TodoCompleted>(&args),
            "v1.TodoUncompleted" => round_trip::<TodoUncompleted>(&args),
            "v1.TodoDeleted" => round_trip::<TodoDeleted>(&args),
            "v1.TodoClearedCompleted" => round_trip::<TodoClearedCompleted>(&args),
            _ => continue,
        }
        checked += 1;
    }
    assert!(
        checked >= 5,
        "expected TodoMVC events in the leader fixtures, found {checked}"
    );
}

/// Decoding TypeScript's JSON and encoding it again gives the same value, through the Rust struct (what the
/// client sends) and through the event schema.
fn round_trip<E: Event>(ts_json: &str) {
    let def = E::def();
    let expected: Value = serde_json::from_str(ts_json).unwrap();

    let decoded = def.decode_json(ts_json).unwrap();
    let encoded: Value = serde_json::from_str(&def.encode_json(&decoded).unwrap()).unwrap();
    assert_eq!(encoded, expected, "{} through the Rust struct", def.name);

    let schema = def.schema.as_ref().unwrap();
    let value = schema.decode(Val::from(expected.clone())).unwrap();
    let encoded = schema.encode(value).unwrap().to_json_value();
    assert_eq!(encoded, expected, "{} through the event schema", def.name);
}

fn ts_encoded_args() -> Vec<(String, String)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/leader");
    let mut args = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap()).unwrap();
        for step in fixture["steps"].as_array().unwrap() {
            for row in step["snapshot"]["eventlog"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let (name, json) = (
                    row["name"].as_str().unwrap(),
                    row["argsJson"].as_str().unwrap(),
                );
                args.push((name.to_string(), json.to_string()));
            }
        }
    }
    args
}
