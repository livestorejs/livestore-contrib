//! Ports of `schema/EventDef/define.test.ts` and `schema/EventDef/deprecated.test.ts`.

use livestore_schema::EventDef;
use livestore_schema::event_def::{DateFromString, DeprecationWarnings};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Occurred {
    occurred_at: DateFromString,
}

/// Args with an optional field, like `Schema.Struct({ old: Schema.optional(Schema.String) })`.
#[derive(Serialize, Deserialize)]
struct Args {
    #[serde(skip_serializing_if = "Option::is_none")]
    old: Option<String>,
}

fn occurred() -> EventDef<Occurred> {
    EventDef::synced("v1.Occurred")
}

#[test]
fn roundtrips_a_valid_date_through_json() {
    let event = occurred();
    let value = Occurred {
        occurred_at: DateFromString(1_784_283_330_000.0),
    };
    let encoded = event.encode_json(&value).unwrap();
    assert_eq!(encoded, r#"{"occurredAt":"2026-07-17T10:15:30.000Z"}"#);
    assert_eq!(event.decode_json(&encoded).unwrap(), value);
}

#[test]
fn rejects_invalid_dates_on_encode_and_decode() {
    let event = occurred();
    assert!(
        event
            .encode_json(&Occurred {
                occurred_at: DateFromString(f64::NAN)
            })
            .is_err()
    );
    assert!(event.decode_json(r#"{"occurredAt":"not-a-date"}"#).is_err());
}

#[test]
fn adds_deprecation_annotation_to_schema() {
    let def = EventDef::<Value>::synced("Ev").deprecated_field("value", "Use newField instead");
    assert!(def.field_deprecation("value").is_some());
}

#[test]
fn works_with_optional_fields_in_struct() {
    let def = EventDef::<Args>::synced("Ev").deprecated_field("oldField", "Legacy");
    assert_eq!(
        def.find_deprecated_fields_with_values(&json!({ "oldField": "x" })),
        [("oldField".to_string(), "Legacy".to_string())]
    );
}

#[test]
fn non_deprecated_schemas_return_false() {
    assert!(
        EventDef::<Value>::synced("Ev")
            .field_deprecation("value")
            .is_none()
    );
}

#[test]
fn ignores_deprecated_fields_without_values() {
    let def = EventDef::<Value>::synced("Ev").deprecated_field("old", "x");
    assert!(
        def.find_deprecated_fields_with_values(&json!({ "id": "1" }))
            .is_empty()
    );
}

#[test]
fn finds_multiple_deprecated_fields() {
    let def = EventDef::<Value>::synced("Ev")
        .deprecated_field("a", "A")
        .deprecated_field("b", "B");
    assert_eq!(
        def.find_deprecated_fields_with_values(&json!({ "a": "1", "b": "2" }))
            .len(),
        2
    );
}

#[test]
fn logs_event_deprecation_warning() {
    let def = EventDef::<Value>::synced("Old").deprecated("Use New");
    let logs = DeprecationWarnings::default().log(&def, &json!({ "id": "1" }));
    assert_eq!(
        logs,
        [(
            "@livestore/schema:deprecated-event",
            json!({ "event": "Old", "reason": "Use New" })
        )]
    );
}

#[test]
fn logs_field_deprecation_warning() {
    let def = EventDef::<Args>::synced("Ev").deprecated_field("old", "Use new");
    let logs = DeprecationWarnings::default().log(&def, &json!({ "old": "x" }));
    assert_eq!(
        logs,
        [(
            "@livestore/schema:deprecated-field",
            json!({ "event": "Ev", "field": "old", "reason": "Use new" })
        )]
    );
}

#[test]
fn deduplicates_event_warnings() {
    let def = EventDef::<Value>::synced("Dup").deprecated("x");
    let mut warnings = DeprecationWarnings::default();
    let first = warnings.log(&def, &json!({ "id": "1" }));
    let second = warnings.log(&def, &json!({ "id": "2" }));
    assert_eq!(first.len() + second.len(), 1);
}

#[test]
fn deduplicates_field_warnings() {
    let def = EventDef::<Args>::synced("DupField").deprecated_field("old", "x");
    let mut warnings = DeprecationWarnings::default();
    let first = warnings.log(&def, &json!({ "old": "a" }));
    let second = warnings.log(&def, &json!({ "old": "b" }));
    assert_eq!(first.len() + second.len(), 1);
}

#[test]
fn no_warning_for_non_deprecated_event() {
    let def = EventDef::<Value>::synced("Normal");
    assert!(
        DeprecationWarnings::default()
            .log(&def, &json!({ "id": "1" }))
            .is_empty()
    );
}

#[test]
fn no_warning_when_deprecated_field_is_undefined() {
    let def = EventDef::<Args>::synced("Unused").deprecated_field("old", "x");
    let encoded = serde_json::to_value(Args { old: None }).unwrap();
    assert!(
        DeprecationWarnings::default()
            .log(&def, &encoded)
            .is_empty()
    );
}

#[test]
fn logs_both_event_and_field_warnings() {
    let def = EventDef::<Args>::synced("Both")
        .deprecated_field("old", "F")
        .deprecated("E");
    assert_eq!(
        DeprecationWarnings::default()
            .log(&def, &json!({ "old": "x" }))
            .len(),
        2
    );
}
