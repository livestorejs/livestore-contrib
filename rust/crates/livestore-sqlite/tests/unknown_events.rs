mod common;

use std::sync::{Arc, Mutex};

use livestore_core::{Event, SeqNum};
use livestore_schema::{EventDef, Schema, UnknownEventHandling, UnknownEventReason};
use livestore_sqlite::eventlog::UNKNOWN_EVENT_SCHEMA_HASH;
use livestore_sqlite::state::RebuildOptions;
use livestore_sqlite::{Error, LeaderDb, materialize_event, state};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use common::{journal_changeset, select};

#[test]
fn warn_strategy_keeps_event_in_log_and_continues() {
    let db = setup(UnknownEventHandling::Warn);
    let event = unknown_event();
    materialize(&db, &event).unwrap();

    assert_eq!(changeset_tag(db.state_conn(), event.seq_num), Some("no-op"));
    assert_eq!(
        eventlog_rows(&db),
        vec![json!({"name": event.name, "schemaHash": UNKNOWN_EVENT_SCHEMA_HASH})]
    );
    assert_eq!(db.state_head().unwrap(), event.seq_num);
}

#[test]
fn ignore_strategy_behaves_like_warn_but_silent() {
    let db = setup(UnknownEventHandling::Ignore);
    let event = unknown_event();
    materialize(&db, &event).unwrap();

    assert_eq!(changeset_tag(db.state_conn(), event.seq_num), Some("no-op"));
    assert_eq!(
        eventlog_rows(&db),
        vec![json!({"name": event.name, "schemaHash": UNKNOWN_EVENT_SCHEMA_HASH})]
    );
}

#[test]
fn fail_strategy_surfaces_unknown_event_error() {
    let db = setup(UnknownEventHandling::Fail);
    let error = materialize(&db, &unknown_event()).unwrap_err();
    let Error::UnknownEvent(error) = error else {
        panic!("Unexpected materialization failure: {error:?}")
    };
    assert_eq!(error.0.reason, UnknownEventReason::EventDefinitionMissing);
}

#[test]
fn callback_strategy_invokes_observer_once() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let c = calls.clone();
    let db = setup(UnknownEventHandling::Callback(Arc::new(move |ctx| {
        c.lock().unwrap().push((ctx.event_name.clone(), ctx.reason));
    })));
    let event = unknown_event();
    materialize(&db, &event).unwrap();

    assert_eq!(changeset_tag(db.state_conn(), event.seq_num), Some("no-op"));
    assert_eq!(
        *calls.lock().unwrap(),
        vec![(event.name, UnknownEventReason::EventDefinitionMissing)]
    );
}

#[test]
fn warn_strategy_skips_events_missing_materializers() {
    let schema = Schema::builder()
        .event_without_materializer(&EventDef::<Known>::synced("known-event"))
        .unknown_event_handling(UnknownEventHandling::Warn)
        .build();
    let db = LeaderDb::open_in_memory(schema).unwrap();
    let event = common::event(
        "known-event",
        json!({"value": "example"}),
        SeqNum::new(1, 0, 0),
        SeqNum::ROOT,
        "client-2",
        "session-2",
    );

    materialize(&db, &event).unwrap();

    assert_eq!(changeset_tag(db.state_conn(), event.seq_num), Some("no-op"));
}

#[test]
fn rematerialization_advances_the_state_head_over_unknown_no_op_events() {
    let db = setup(UnknownEventHandling::Warn);
    let event = unknown_event();
    materialize(&db, &event).unwrap();

    let rematerialized = Connection::open_in_memory().unwrap();
    state::rebuild(
        &rematerialized,
        db.eventlog_conn(),
        db.schema(),
        &RebuildOptions::default(),
    )
    .unwrap();

    assert_eq!(state::head(&rematerialized).unwrap(), event.seq_num);
    assert_eq!(changeset_tag(&rematerialized, event.seq_num), Some("no-op"));
}

#[derive(Serialize, Deserialize)]
struct Known {
    value: String,
}

fn setup(handling: UnknownEventHandling) -> LeaderDb {
    LeaderDb::open_in_memory(Schema::builder().unknown_event_handling(handling).build()).unwrap()
}

fn materialize(db: &LeaderDb, event: &Event) -> Result<(), Error> {
    materialize_event(
        db.state_conn(),
        db.eventlog_conn(),
        db.schema(),
        event,
        false,
        None,
    )
}

fn unknown_event() -> Event {
    common::event(
        "v1.UnknownEvent",
        json!({"payload": "test"}),
        SeqNum::new(1, 0, 0),
        SeqNum::ROOT,
        "client-1",
        "session-1",
    )
}

fn changeset_tag(conn: &Connection, key: SeqNum) -> Option<&'static str> {
    journal_changeset(conn, key).map(|c| if c.is_none() { "no-op" } else { "changeset" })
}

fn eventlog_rows(db: &LeaderDb) -> Vec<Value> {
    select(db.eventlog_conn(), "SELECT name, schemaHash FROM eventlog")
        .into_iter()
        .map(Value::Object)
        .collect()
}
