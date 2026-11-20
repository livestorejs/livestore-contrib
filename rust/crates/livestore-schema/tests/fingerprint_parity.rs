//! Port of `schema/state/sqlite/db-schema/ast/fingerprint.test.ts`. Effect schema representation
//! documents are dumped from TS into `fixtures/fingerprint_schemas.json`.

use std::sync::LazyLock;

use livestore_schema::fingerprint::{db_fingerprint, digest_to_fingerprint, table_fingerprint};
use livestore_schema::migration::state_hash;
use livestore_schema::system_tables::{REBUILD_TABLE, state_tables};
use livestore_schema::{Column, ColumnDefault, Table};
use serde_json::Value;

/// `liveStoreStorageFormatVersion`.
const STORAGE_FORMAT_VERSION: u32 = 6;

static SCHEMAS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("fixtures/fingerprint_schemas.json")).unwrap()
});

fn repr(key: &str) -> Value {
    SCHEMAS[key].clone()
}

fn physical_table() -> Table {
    Table::new("users")
        .column(Column::text("id").primary_key())
        .column(Column::integer("age").nullable())
        .index("users_by_age", &["age"])
}

fn json_table(name: &str, schema: &str) -> Table {
    Table::new(name)
        .column(Column::text("id").primary_key())
        .column(Column::json("value").schema_repr(repr(schema)))
}

#[test]
fn pins_the_final_fingerprint_output() {
    assert_eq!(
        table_fingerprint(&physical_table()),
        "UnLwYzVBhwzPCK5q7TrPU3q2N0dTe8m_98bud8HsAs8"
    );
    assert_eq!(
        table_fingerprint(&json_table("documents", "representative")),
        "kUzaurzV2rcXYLljHOZ64TDR9c_RebqD7y5ZUM_nPBE"
    );
    assert_eq!(
        table_fingerprint(&json_table("documents", "normalized")),
        "I0XYuOUSYqWwG5Opxbc1u-TNNE3pFQCHzpBZ_ChYGaA"
    );
    assert_eq!(
        state_hash([]),
        "1_2x-8RoI45JYrfY63I7lNiHj4ptli9Ong1XNS1gA10"
    );
}

#[test]
fn isolates_pre_completion_marker_state_databases_without_changing_the_hash_algorithm() {
    let legacy: Vec<Table> = state_tables()
        .into_iter()
        .filter(|t| t.name != REBUILD_TABLE)
        .collect();
    let legacy_hash = db_fingerprint(&legacy);
    assert_eq!(legacy_hash, "0Ce3j3biUjf2_KpqhAVO5tS222iEWtwju9xIP8EkGKc");
    assert_ne!(state_hash([]), legacy_hash);
}

#[test]
fn matches_the_standard_sha_256_vector() {
    assert_eq!(
        digest_to_fingerprint(b"abc"),
        "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
    );
}

#[test]
fn keeps_the_full_digest_inside_the_cloudflare_vfs_filename_limit() {
    let value = table_fingerprint(&physical_table());
    assert_eq!(value.len(), 43);
    assert!(format!("state{value}@{STORAGE_FORMAT_VERSION}.db").len() <= 56);
}

#[test]
fn is_independent_of_table_and_index_declaration_order() {
    let first = json_table("first", "value_string");
    let second = json_table("second", "value_finite");
    assert_eq!(
        db_fingerprint([&first, &second]),
        db_fingerprint([&second, &first])
    );

    let table = Table::new("indexed")
        .column(Column::text("id").primary_key())
        .column(Column::integer("age"))
        .index("indexed_by_age", &["age"])
        .unique_index("indexed_by_id", &["id"]);
    let mut reversed = table.clone();
    reversed.indexes.reverse();
    assert_eq!(table_fingerprint(&reversed), table_fingerprint(&table));
}

#[test]
fn ignores_effect_metadata_that_does_not_affect_accepted_encoded_json() {
    assert_eq!(
        table_fingerprint(&json_table("documents", "value_string")),
        table_fingerprint(&json_table("documents", "value_string_annotated"))
    );
    assert_eq!(
        table_fingerprint(&json_table("documents", "array_string")),
        table_fingerprint(&json_table("documents", "array_string_mutable"))
    );
}

#[test]
fn changes_when_represented_json_checks_change() {
    assert_ne!(
        table_fingerprint(&json_table("documents", "min2")),
        table_fingerprint(&json_table("documents", "min3"))
    );
}

#[test]
fn distinguishes_codecs_with_the_same_encoded_primitive() {
    assert_ne!(
        table_fingerprint(&json_table("documents", "date")),
        table_fingerprint(&json_table("documents", "value_string"))
    );
}

#[test]
fn handles_recursive_json_schemas_deterministically() {
    assert_eq!(
        table_fingerprint(&json_table("trees", "tree")),
        table_fingerprint(&json_table("trees", "tree"))
    );
}

#[test]
fn supports_opaque_effect_schemas_without_persistence_annotations() {
    assert_eq!(
        table_fingerprint(&json_table("opaque_documents", "opaque")).len(),
        43
    );
}

#[test]
fn keeps_application_owned_representation_payload_fields() {
    assert_ne!(
        table_fingerprint(&json_table("documents", "payload_first")),
        table_fingerprint(&json_table("documents", "payload_second"))
    );
}

#[test]
fn tracks_json_codecs_passed_through_the_generic_text_column_api() {
    let first =
        Table::new("documents").column(Column::text("value").schema_repr(repr("json_generic")));
    let second =
        Table::new("documents").column(Column::text("value").schema_repr(repr("value_finite")));
    assert_ne!(table_fingerprint(&first), table_fingerprint(&second));
}

#[test]
fn gives_equivalent_json_dsl_forms_the_same_fingerprint() {
    let specialized =
        Table::new("documents").column(Column::json("value").schema_repr(repr("value_string")));
    let generic =
        Table::new("documents").column(Column::text("value").schema_repr(repr("json_generic")));
    assert_eq!(table_fingerprint(&specialized), table_fingerprint(&generic));
}

#[test]
fn classifies_physical_defaults_without_hashing_function_source_text() {
    let table = |column: Column| Table::new("defaults").column(column);
    let none = table(Column::text("value"));
    let first_thunk =
        table(Column::text("value").default(ColumnDefault::thunk(|| livestore_schema::Val::Null)));
    let second_thunk =
        table(Column::text("value").default(ColumnDefault::thunk(|| livestore_schema::Val::Null)));
    let literal = table(Column::text("value").default("first"));
    assert_eq!(
        table_fingerprint(&first_thunk),
        table_fingerprint(&second_thunk)
    );
    assert_ne!(table_fingerprint(&first_thunk), table_fingerprint(&none));
    assert_ne!(table_fingerprint(&literal), table_fingerprint(&first_thunk));
}
