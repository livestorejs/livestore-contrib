//! `#[derive(Event)]` builds the same definition as the hand-written `EventDef`.

use livestore_schema::event_def::DateFromString;
use livestore_schema::value_schema as s;
use livestore_schema::{Event, EventDef, Events};
use serde::{Deserialize, Serialize};

#[derive(Event, Serialize, Deserialize)]
#[event(name = "v1.TodoDeleted", deprecated = "use v2")]
#[serde(rename_all = "camelCase")]
struct TodoDeleted {
    id: String,
    deleted_at: DateFromString,
    #[event(deprecated = "unused")]
    #[serde(rename = "why")]
    reason: Option<String>,
}

#[derive(Event, Serialize, Deserialize)]
#[event(name = "reset", client_only)]
struct Reset;

#[test]
fn derived_definition_matches_the_hand_written_one() {
    let hand: EventDef<TodoDeleted> = EventDef::synced("v1.TodoDeleted")
        .schema(s::struct_([
            ("id", s::string()),
            ("deletedAt", s::date_from_string()),
            ("why", s::null_or(s::string())),
        ]))
        .deprecated("use v2")
        .deprecated_field("why", "unused");
    let derived = TodoDeleted::def();
    assert_eq!(
        (
            TodoDeleted::NAME,
            derived.client_only,
            derived.schema_hash(),
            &derived.deprecated,
            &derived.deprecated_fields
        ),
        (
            "v1.TodoDeleted",
            false,
            hand.schema_hash(),
            &hand.deprecated,
            &hand.deprecated_fields
        ),
    );
}

#[test]
fn a_unit_struct_is_a_client_only_event_without_args() {
    let def = Reset::def();
    assert_eq!(
        (def.client_only, def.schema_hash()),
        (
            true,
            EventDef::<Reset>::client_only("reset")
                .schema(s::void())
                .schema_hash()
        ),
    );
}

#[test]
fn a_mixed_tuple_keeps_its_order() {
    let deleted = TodoDeleted {
        id: "a".into(),
        deleted_at: DateFromString::now(),
        reason: None,
    };
    let names: Vec<String> = (Reset, (deleted, vec![Reset]))
        .into_inputs()
        .iter()
        .map(|e| e.name().to_owned())
        .collect();
    assert_eq!(names, ["reset", "v1.TodoDeleted", "reset"]);
}
