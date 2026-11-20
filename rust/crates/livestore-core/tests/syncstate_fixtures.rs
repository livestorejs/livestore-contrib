use std::fs;

use livestore_core::{Event, Payload, SyncState, is_equal_encoded, merge};
use serde_json::Value;

#[test]
fn syncstate_fixtures_match_typescript() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/syncstate");
    let mut count = 0;
    let mut failures = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let cases: Vec<Value> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for case in cases {
            count += 1;
            let sync_state: SyncState = serde_json::from_value(case["syncState"].clone()).unwrap();
            let payload: Payload = serde_json::from_value(case["payload"].clone()).unwrap();
            let ignore = case["ignoreClientOnlyEvents"].as_bool().unwrap();
            let actual = match merge(
                &sync_state,
                &payload,
                is_client_only,
                is_equal_encoded,
                ignore,
            ) {
                Ok(result) => serde_json::to_value(result).unwrap(),
                Err(err) => serde_json::json!({ "_tag": "die", "message": err.0 }),
            };
            if actual != case["result"] {
                failures.push(format!(
                    "{} / {}\n  expected: {}\n  actual:   {}",
                    path.file_name().unwrap().to_string_lossy(),
                    case["name"],
                    case["result"],
                    actual
                ));
            }
        }
    }
    assert!(count > 0, "no fixtures found");
    assert!(
        failures.is_empty(),
        "{} of {count} fixtures failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn is_client_only(event: &Event) -> bool {
    event.args.get("isClientOnly") == Some(&Value::Bool(true))
}
