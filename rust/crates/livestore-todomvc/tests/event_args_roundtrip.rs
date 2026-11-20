//! Event arguments cross clients as JSON, so Rust must read what TypeScript writes and write what TypeScript
//! reads. The leader fixtures hold arguments that core's TypeScript leader encoded into its eventlog.

use livestore_schema::EventDef;
use livestore_schema::value_schema::Val;
use livestore_todomvc::events;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

#[test]
fn event_args_round_trip_with_typescript() {
    let mut checked = 0;
    for (name, args) in ts_encoded_args() {
        match name.as_str() {
            "v1.TodoCreated" => round_trip(&events::TODO_CREATED, &args),
            "v1.TodoCompleted" => round_trip(&events::TODO_COMPLETED, &args),
            "v1.TodoUncompleted" => round_trip(&events::TODO_UNCOMPLETED, &args),
            "v1.TodoDeleted" => round_trip(&events::TODO_DELETED, &args),
            "v1.TodoClearedCompleted" => round_trip(&events::TODO_CLEARED_COMPLETED, &args),
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
fn round_trip<A: Serialize + DeserializeOwned>(def: &EventDef<A>, ts_json: &str) {
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
