//! Port of `schema/LiveStoreEvent/client.test.ts`. Rust args are JSON values, so TS `undefined`
//! fields correspond to absent keys (serde `skip_serializing_if`).

use livestore_core::{Event, SeqNum, is_equal_encoded};
use serde::Serialize;
use serde_json::{Value, json};

fn make(args: Value) -> Event {
    Event {
        name: "testEvent-v1".into(),
        args,
        seq_num: SeqNum::new(1, 0, 0),
        parent_seq_num: SeqNum::ROOT,
        client_id: "client-1".into(),
        session_id: "session-1".into(),
    }
}

fn equal(a: Value, b: Value) -> bool {
    is_equal_encoded(&make(a), &make(b))
}

/// Locally encoded args vs. their JSON wire roundtrip.
fn local_and_wire<T: Serialize>(args: T) -> (Value, Value) {
    let local = serde_json::to_value(args).unwrap();
    let wire = serde_json::from_str(&serde_json::to_string(&local).unwrap()).unwrap();
    (local, wire)
}

#[test]
fn to_global_produces_numeric_seq_nums_through_json_stringify() {
    let event = Event {
        name: "test-v1".into(),
        args: json!({ "id": "1" }),
        seq_num: SeqNum::new(5, 0, 0),
        parent_seq_num: SeqNum::new(4, 0, 0),
        client_id: "client-1".into(),
        session_id: "session-1".into(),
    };
    let parsed: Value =
        serde_json::from_str(&serde_json::to_string(&event.to_global()).unwrap()).unwrap();
    assert_eq!(parsed["seqNum"], json!(5));
    assert_eq!(parsed["parentSeqNum"], json!(4));
}

#[test]
fn should_consider_events_with_identical_args_as_equal() {
    assert!(equal(
        json!({ "id": "abc", "text": "hello" }),
        json!({ "id": "abc", "text": "hello" })
    ));
}

#[test]
fn should_consider_events_with_different_key_order_in_args_as_equal() {
    assert!(equal(json!({ "b": 2, "a": 1 }), json!({ "a": 1, "b": 2 })));
}

#[test]
fn should_consider_events_with_different_key_order_in_nested_args_as_equal() {
    assert!(equal(
        json!({ "outer": { "b": 2, "a": 1 }, "x": "y" }),
        json!({ "x": "y", "outer": { "a": 1, "b": 2 } })
    ));
}

#[test]
fn should_consider_events_with_different_args_values_as_not_equal() {
    assert!(!equal(json!({ "id": "abc" }), json!({ "id": "def" })));
}

#[test]
fn should_consider_events_with_different_args_keys_as_not_equal() {
    assert!(!equal(json!({ "a": 1 }), json!({ "b": 1 })));
}

#[test]
fn should_handle_null_args() {
    assert!(equal(Value::Null, Value::Null));
}

#[test]
fn should_handle_array_args() {
    assert!(equal(json!([1, 2, 3]), json!([1, 2, 3])));
}

#[test]
fn should_handle_empty_object_args() {
    assert!(equal(json!({}), json!({})));
}

#[test]
fn should_consider_events_with_different_names_as_not_equal() {
    let a = Event {
        name: "eventA".into(),
        ..make(json!({ "id": "abc" }))
    };
    let b = Event {
        name: "eventB".into(),
        ..make(json!({ "id": "abc" }))
    };
    assert!(!is_equal_encoded(&a, &b));
}

#[derive(Serialize)]
struct WithFlag {
    id: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    flag: Option<bool>,
}

#[test]
fn should_consider_events_with_undefined_valued_and_missing_keys_as_equal() {
    let a = serde_json::to_value(WithFlag {
        id: "abc",
        flag: None,
    })
    .unwrap();
    assert!(equal(a, json!({ "id": "abc" })));
}

#[test]
fn should_consider_events_with_nested_undefined_valued_and_missing_keys_as_equal() {
    #[derive(Serialize)]
    struct Inner {
        x: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<i64>,
    }
    let a = json!({ "outer": Inner { x: 1, y: None } });
    assert!(equal(a, json!({ "outer": { "x": 1 } })));
}

#[test]
fn should_consider_effect_schema_undefined_or_encoded_args_with_explicit_undefined_equal_to_their_json_roundtripped_form()
 {
    let (local, wire) = local_and_wire(WithFlag {
        id: "abc",
        flag: None,
    });
    assert!(equal(local, wire));
}

#[test]
fn should_consider_effect_schema_optional_key_encoded_args_equal_to_their_json_roundtripped_form() {
    #[derive(Serialize)]
    struct WithLabel {
        id: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    }
    let (local, wire) = local_and_wire(WithLabel {
        id: "abc",
        label: None,
    });
    assert!(equal(local, wire));
}

#[test]
fn should_consider_effect_schema_loose_optional_encoded_args_equal_to_their_json_roundtripped_form()
{
    #[derive(Serialize)]
    struct WithLooseLabel {
        id: &'static str,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    }
    let (local, wire) = local_and_wire(WithLooseLabel {
        id: "abc",
        label: None,
    });
    assert!(equal(local, wire));
}
