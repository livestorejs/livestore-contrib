mod common;

use livestore_core::SeqNum;
use livestore_sqlite::state;

#[test]
fn get_returns_the_root_head_for_an_empty_current_schema_state_database() {
    let db = common::migrated_state(&common::schema());
    assert_eq!(state::head(&db).unwrap(), SeqNum::ROOT);
}

#[test]
fn set_persists_a_state_head() {
    let db = common::migrated_state(&common::schema());
    let head = SeqNum::new(1, 0, 0);
    state::set_head(&db, head).unwrap();
    assert_eq!(state::head(&db).unwrap(), head);
}

#[test]
fn set_replaces_the_complete_persisted_state_head() {
    let db = common::migrated_state(&common::schema());
    state::set_head(&db, SeqNum::new(3, 2, 1)).unwrap();
    let replacement = SeqNum::new(2, 4, 7);
    state::set_head(&db, replacement).unwrap();
    assert_eq!(state::head(&db).unwrap(), replacement);
}
