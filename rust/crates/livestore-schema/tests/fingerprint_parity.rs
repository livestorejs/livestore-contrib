//! Port of `schema/state/sqlite/db-schema/ast/fingerprint.test.ts`. Physical tables hash exactly like core.
//! JSON columns hash Rust's own schema description instead of Effect's `SchemaRepresentation`, so the
//! tests use Rust schemas and the pinned JSON values are Rust's own.

use livestore_schema::fingerprint::{db_fingerprint, digest_to_fingerprint, table_fingerprint};
use livestore_schema::migration::state_hash;
use livestore_schema::system_tables::{REBUILD_TABLE, state_tables};
use livestore_schema::value_schema::{self as s, Annotation, ValueSchema};
use livestore_schema::{Column, ColumnDefault, Table};
use serde_json::json;

/// `liveStoreStorageFormatVersion`.
const STORAGE_FORMAT_VERSION: u32 = 6;

fn value(schema: ValueSchema) -> ValueSchema {
    s::struct_([("value", schema)])
}

fn min_length(min: usize) -> ValueSchema {
    value(s::string().check(s::is_min_length(min)))
}

fn opaque(payload: &str) -> ValueSchema {
    s::date().annotate(
        "representation",
        Annotation::Json(json!({ "id": "example/opaque", "payload": { "annotations": payload } })),
    )
}

fn tree() -> ValueSchema {
    s::struct_([
        ("value", s::string()),
        ("children", s::array(s::suspend(tree))),
    ])
}

fn physical_table() -> Table {
    Table::new("users")
        .column(Column::text("id").primary_key())
        .column(Column::integer("age").nullable())
        .index("users_by_age", &["age"])
}

fn json_table(name: &str, schema: ValueSchema) -> Table {
    Table::new(name)
        .column(Column::text("id").primary_key())
        .column(Column::json("value").schema(schema))
}

#[test]
fn pins_the_final_fingerprint_output() {
    assert_eq!(
        table_fingerprint(&physical_table()),
        "UnLwYzVBhwzPCK5q7TrPU3q2N0dTe8m_98bud8HsAs8"
    );
    assert_eq!(
        table_fingerprint(&json_table(
            "documents",
            s::struct_([
                ("title", s::non_empty_string()),
                ("tags", s::array(s::string()))
            ])
        )),
        "LrvW7RAfw8ZUYQ4rDIp1bmBdwbMD0hOt01UfbMs1L90"
    );
    assert_eq!(
        table_fingerprint(&json_table("documents", value(s::string()))),
        "D0ql3NRW601aHUWj9-wVsQ_wAvyURYWD0NMeSAq8hsc"
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
    let first = json_table("first", value(s::string()));
    let second = json_table("second", value(s::finite()));
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
        table_fingerprint(&json_table("documents", value(s::string()))),
        table_fingerprint(&json_table(
            "documents",
            value(s::string()).title("Document")
        ))
    );
    assert_eq!(
        table_fingerprint(&json_table("documents", s::array(s::string()))),
        table_fingerprint(&json_table(
            "documents",
            s::array(s::string()).title("Tags")
        ))
    );
}

#[test]
fn changes_when_represented_json_checks_change() {
    assert_ne!(
        table_fingerprint(&json_table("documents", min_length(2))),
        table_fingerprint(&json_table("documents", min_length(3)))
    );
}

#[test]
fn distinguishes_codecs_with_the_same_encoded_primitive() {
    assert_ne!(
        table_fingerprint(&json_table("documents", value(s::date_from_string()))),
        table_fingerprint(&json_table("documents", value(s::string())))
    );
}

#[test]
fn handles_recursive_json_schemas_deterministically() {
    assert_eq!(
        table_fingerprint(&json_table("trees", tree())),
        table_fingerprint(&json_table("trees", tree()))
    );
}

#[test]
fn supports_opaque_effect_schemas_without_persistence_annotations() {
    assert_eq!(
        table_fingerprint(&json_table("opaque_documents", value(s::date()))).len(),
        43
    );
}

#[test]
fn keeps_application_owned_representation_payload_fields() {
    assert_ne!(
        table_fingerprint(&json_table("documents", opaque("first"))),
        table_fingerprint(&json_table("documents", opaque("second")))
    );
}

#[test]
fn tracks_json_codecs_passed_through_the_generic_text_column_api() {
    let first = Table::new("documents")
        .column(Column::text("value").schema(s::from_json_string(value(s::string()))));
    let second = Table::new("documents")
        .column(Column::text("value").schema(s::from_json_string(value(s::finite()))));
    assert_ne!(table_fingerprint(&first), table_fingerprint(&second));
}

#[test]
fn gives_equivalent_json_dsl_forms_the_same_fingerprint() {
    let specialized =
        Table::new("documents").column(Column::json("value").schema(value(s::string())));
    let generic = Table::new("documents")
        .column(Column::text("value").schema(s::from_json_string(value(s::string()))));
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
