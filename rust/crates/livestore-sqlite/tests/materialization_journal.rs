mod common;

use livestore_core::SeqNum;
use livestore_sqlite::{Error, state};
use rusqlite::Connection;
use rusqlite::session::Session;
use serde_json::json;

use common::{journal_changeset, select};

#[test]
fn replaces_the_changeset_at_an_existing_materialization_key() {
    let db = setup();
    let key = SeqNum::new(1, 2, 3);
    state::journal_record(&db, key, Some(&[1, 2, 3])).unwrap();
    state::journal_record(&db, key, Some(&[4, 5, 6])).unwrap();
    assert_eq!(journal_changeset(&db, key), Some(Some(vec![4, 5, 6])));
}

#[test]
fn discards_records_up_to_the_key() {
    let db = setup();
    let key = SeqNum::new(1, 2, 3);
    state::journal_record(&db, key, None).unwrap();
    let same_sequence_key = SeqNum::new(1, 2, 4);
    state::journal_record(&db, same_sequence_key, None).unwrap();
    let later_key = SeqNum::new(1, 3, 0);
    state::journal_record(&db, later_key, None).unwrap();

    state::discard_journal_up_to(&db, key).unwrap();

    assert_eq!(journal_changeset(&db, key), None);
    assert_eq!(journal_changeset(&db, same_sequence_key), None);
    assert_eq!(journal_changeset(&db, later_key), Some(None));
}

#[test]
fn rolls_changesets_back_in_reverse_materialization_order_and_removes_their_records() {
    let db = setup();
    let insert_key = SeqNum::new(1, 0, 0);
    let insert = capture(
        &db,
        "INSERT INTO journal_test (id, value) VALUES (1, 'created')",
    );
    state::journal_record(&db, insert_key, Some(&insert)).unwrap();
    let update_key = SeqNum::new(2, 0, 0);
    let update = capture(
        &db,
        "UPDATE journal_test SET value = 'updated' WHERE id = 1",
    );
    state::journal_record(&db, update_key, Some(&update)).unwrap();
    let no_op_key = SeqNum::new(3, 0, 0);
    state::journal_record(&db, no_op_key, None).unwrap();

    state::rollback(&db, &[insert_key, no_op_key, update_key]).unwrap();

    assert!(select(&db, "SELECT id, value FROM journal_test").is_empty());
    assert_eq!(journal_changeset(&db, insert_key), None);
    assert_eq!(journal_changeset(&db, update_key), None);
    assert_eq!(journal_changeset(&db, no_op_key), None);
}

#[test]
fn rolls_back_more_records_than_fit_in_one_statement() {
    let db = setup();
    let keys: Vec<SeqNum> = (0..250).map(|i| SeqNum::new(i + 1, 0, 0)).collect();
    for (index, key) in keys.iter().enumerate() {
        let sql = if index == 0 {
            "INSERT INTO journal_test (id, value) VALUES (1, 'v0')".to_string()
        } else {
            format!("UPDATE journal_test SET value = 'v{index}' WHERE id = 1")
        };
        let changeset = capture(&db, &sql);
        state::journal_record(&db, *key, Some(&changeset)).unwrap();
    }

    let mut with_missing = keys.clone();
    with_missing.push(SeqNum::new(999, 0, 0));
    let error = state::rollback(&db, &with_missing).unwrap_err();
    assert_rollback_error(&error);
    assert_eq!(rows(&db), vec![json!({"id": 1, "value": "v249"})]);

    let reversed: Vec<SeqNum> = keys.iter().rev().copied().collect();
    state::rollback(&db, &reversed).unwrap();

    assert!(rows(&db).is_empty());
    assert!(keys.iter().all(|k| journal_changeset(&db, *k).is_none()));
}

#[test]
fn fails_without_changing_state_when_a_requested_record_is_missing() {
    let db = setup();
    let recorded_key = SeqNum::new(2, 0, 0);
    let changeset = capture(
        &db,
        "INSERT INTO journal_test (id, value) VALUES (1, 'kept')",
    );
    state::journal_record(&db, recorded_key, Some(&changeset)).unwrap();

    let missing_key = SeqNum::new(1, 0, 0);
    let error = state::rollback(&db, &[recorded_key, missing_key]).unwrap_err();
    assert_rollback_error(&error);
    assert_eq!(
        error.to_string(),
        format!(
            "MaterializationJournalError: rollback: Missing materialization journal record for {missing_key}"
        )
    );

    assert_eq!(rows(&db), vec![json!({"id": 1, "value": "kept"})]);
    assert_eq!(journal_changeset(&db, recorded_key), Some(Some(changeset)));
}

#[test]
fn restores_earlier_inverse_changes_when_a_later_changeset_fails() {
    let db = setup();
    let valid_key = SeqNum::new(2, 0, 0);
    let valid = capture(
        &db,
        "INSERT INTO journal_test (id, value) VALUES (1, 'kept')",
    );
    state::journal_record(&db, valid_key, Some(&valid)).unwrap();
    let invalid_key = SeqNum::new(1, 0, 0);
    state::journal_record(&db, invalid_key, Some(&[1, 2, 3])).unwrap();

    let error = state::rollback(&db, &[valid_key, invalid_key]).unwrap_err();
    assert_rollback_error(&error);
    assert!(error.to_string().contains("SqliteError"), "{error}");

    assert_eq!(rows(&db), vec![json!({"id": 1, "value": "kept"})]);
    assert_eq!(journal_changeset(&db, valid_key), Some(Some(valid)));
    assert_eq!(
        journal_changeset(&db, invalid_key),
        Some(Some(vec![1, 2, 3]))
    );
}

fn setup() -> Connection {
    let db = common::migrated_state(&common::schema());
    db.execute_batch("CREATE TABLE journal_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        .unwrap();
    db
}

fn capture(db: &Connection, sql: &str) -> Vec<u8> {
    let mut session = Session::new(db).unwrap();
    session.attach::<&str>(None).unwrap();
    db.execute_batch(sql).unwrap();
    let mut bytes = Vec::new();
    session.changeset_strm(&mut bytes).unwrap();
    assert!(
        !bytes.is_empty(),
        "Expected mutation to produce a SQLite changeset"
    );
    bytes
}

fn rows(db: &Connection) -> Vec<serde_json::Value> {
    select(db, "SELECT id, value FROM journal_test")
        .into_iter()
        .map(serde_json::Value::Object)
        .collect()
}

fn assert_rollback_error(error: &Error) {
    assert!(
        matches!(error, Error::MaterializationJournal(m) if m.starts_with("rollback:")),
        "{error:?}"
    );
}
