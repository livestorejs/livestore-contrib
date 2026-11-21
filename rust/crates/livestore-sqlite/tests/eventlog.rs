mod common;

use livestore_core::SeqNum;
use livestore_sqlite::eventlog;
use rusqlite::Connection;
use serde_json::json;

#[test]
fn deletes_every_rebase_generation_at_a_logical_event_position() {
    let db = Connection::open_in_memory().unwrap();
    eventlog::init(&db).unwrap();
    let make = |generation: i64| {
        common::event(
            "todoCreated",
            json!({"id": format!("todo-{generation}"), "text": "todo", "completed": false}),
            SeqNum::new(1, 1, generation),
            SeqNum::ROOT,
            "client-1",
            "session-1",
        )
    };
    let generations = [make(0), make(1)];
    for event in &generations {
        eventlog::insert(&db, event, 0, None).unwrap();
    }

    eventlog::delete_events(&db, &[generations[0].seq_num]).unwrap();

    assert_eq!(
        common::select(&db, "SELECT * FROM eventlog"),
        Vec::<livestore_sqlite::Row>::new()
    );
}
