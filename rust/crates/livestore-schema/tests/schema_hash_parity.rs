//! Rust-built schemas hash exactly like their TS twins: storage fingerprints of tables (JSON columns hash their
//! Effect representation) and `Schema.hash` of event args. Expected values come from
//! `scripts/gen-schema-hash-fixtures.ts` (`fixtures/schema_hashes.json`).

use std::sync::LazyLock;

use livestore_schema::column::with_primary_key;
use livestore_schema::fingerprint::table_fingerprint;
use livestore_schema::representation::schema_hash;
use livestore_schema::value_schema::{self as s, Val, ValueSchema};
use livestore_schema::{ClientDocument, Column, Table};
use serde_json::{Value, json};

static FIXTURES: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("fixtures/schema_hashes.json")).unwrap());

#[test]
fn table_fingerprints_match_ts() {
    let mut cases: Vec<(String, Table)> = vec![];
    for (key, schema) in values() {
        cases.push((
            format!("json_{key}"),
            json_table(key, schema.clone(), false),
        ));
        cases.push((
            format!("json_nullable_{key}"),
            json_table(key, schema, true),
        ));
    }
    let docs = |column: Column| {
        Table::new("docs")
            .column(Column::text("id").primary_key())
            .column(column)
    };
    cases.extend([
        ("json_default".into(), docs(Column::json("value"))),
        (
            "json_default_nullable".into(),
            docs(Column::json("value").nullable()),
        ),
        (
            "json_with_default".into(),
            docs(
                Column::json("value")
                    .schema(struct_schema())
                    .default(Val::from(json!({ "a": "x", "n": 1 }))),
            ),
        ),
        (
            "text_json_codec".into(),
            docs(Column::text("value").schema(s::from_json_string(struct_schema()))),
        ),
        ("physical".into(), physical()),
        ("derived".into(), derived()),
        ("client_document_ui_state".into(), ui_state().table()),
        ("client_document_settings".into(), settings().table()),
        ("client_document_counter".into(), counter().table()),
    ]);
    let fixtures = FIXTURES["tables"].as_object().unwrap();
    assert_eq!(cases.len(), fixtures.len());
    for (key, table) in cases {
        assert_eq!(
            table_fingerprint(&table),
            fixtures[&key]["fingerprint"],
            "{key}"
        );
    }
}

#[test]
fn event_schema_hashes_match_ts() {
    let mut cases: Vec<(&str, ValueSchema)> = values();
    cases.extend([
        (
            "todoCreated",
            s::struct_([("id", s::string()), ("text", s::string())]),
        ),
        ("todoId", s::struct_([("id", s::string())])),
        (
            "todoDeleted",
            s::struct_([("id", s::string()), ("deletedAt", s::date_from_string())]),
        ),
        ("titled", s::struct_([("id", s::string())]).title("Titled")),
        ("uiStateSet", ui_state().set_event_schema()),
        ("settingsSet", settings().set_event_schema()),
        ("counterSet", counter().set_event_schema()),
    ]);
    let fixtures = FIXTURES["events"].as_object().unwrap();
    assert_eq!(cases.len(), fixtures.len());
    for (key, schema) in cases {
        assert_eq!(
            i64::from(schema_hash(&schema)),
            fixtures[key]["hash"],
            "{key}"
        );
    }
}

fn values() -> Vec<(&'static str, ValueSchema)> {
    vec![
        ("struct", struct_schema()),
        (
            "nested",
            s::struct_([
                (
                    "outer",
                    s::struct_([("inner", s::struct_([("x", s::int())]))]),
                ),
                ("list", s::array(s::struct_([("y", s::string())]))),
            ]),
        ),
        (
            "literals",
            s::struct_([
                ("one", s::literal("x")),
                ("many", s::literals(["all", "active", "completed"])),
                ("num", s::literal(1)),
                ("flag", s::literal(true)),
            ]),
        ),
        (
            "unions",
            s::struct_([
                (
                    "mixed",
                    s::union([s::string(), s::number(), s::struct_([("a", s::boolean())])]),
                ),
                ("nullable", s::null_or(s::string())),
                ("undef", s::undefined_or(s::number())),
            ]),
        ),
        (
            "dates",
            s::struct_([
                ("iso", s::date_from_string()),
                ("millis", s::date_from_millis()),
                ("maybe", s::null_or(s::date_from_string())),
            ]),
        ),
        (
            "optional",
            s::struct_([
                ("a", s::optional(s::string())),
                ("b", s::optional_key(s::number())),
            ]),
        ),
        (
            "checks",
            s::struct_([
                ("nonEmpty", s::non_empty_string()),
                ("min3", s::string().check(s::is_min_length(3))),
                ("int", s::int()),
                ("finite", s::finite()),
                ("between", s::number().check(s::is_between(1.0, 5.0))),
                (
                    "gte",
                    s::number().check(s::is_greater_than_or_equal_to(3.0)),
                ),
                ("pattern", s::string().check(s::is_pattern("^[A-Z]+$"))),
                (
                    "custom",
                    s::string().check(s::make_filter("length > 1", |v| {
                        v.as_str().is_some_and(|s| s.len() > 1)
                    })),
                ),
                ("trim", s::trim()),
                ("after", s::date().check(s::is_greater_than_date(0.0))),
            ]),
        ),
        (
            "collections",
            s::struct_([
                ("record", s::record(s::number())),
                ("tuple", s::tuple([s::string(), s::number()])),
                ("strings", s::array(s::string())),
            ]),
        ),
        (
            "codecs",
            s::struct_([
                ("bits", s::boolean_from_bit()),
                ("bytes", s::uint8array_from_base64()),
                ("finite", s::finite_from_string()),
                (
                    "person",
                    s::class(
                        "Person",
                        s::struct_([("name", s::string()), ("age", s::int())]),
                    ),
                ),
            ]),
        ),
        (
            "ids",
            s::struct_([
                ("uuid", s::string().check(s::is_uuid())),
                ("ulid", s::string().check(s::is_ulid())),
            ]),
        ),
        (
            "scalars",
            s::struct_([
                ("s", s::string()),
                ("b", s::boolean()),
                ("u", s::unknown()),
                ("a", s::any()),
                ("z", s::null()),
            ]),
        ),
        ("array", s::array(s::string())),
        ("string", s::string()),
        ("any", s::any()),
    ]
}

fn struct_schema() -> ValueSchema {
    s::struct_([("a", s::string()), ("n", s::number())])
}

fn json_table(name: &str, schema: ValueSchema, nullable: bool) -> Table {
    let value = Column::json("value").schema(schema);
    Table::new(name)
        .column(Column::text("id").primary_key())
        .column(if nullable { value.nullable() } else { value })
}

fn physical() -> Table {
    Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""))
        .column(Column::boolean("completed").default(false))
        .column(
            Column::integer("deletedAt")
                .schema(s::date_from_millis())
                .nullable(),
        )
        .column(Column::datetime("at").nullable())
        .column(Column::datetime_millis("atMs"))
        .column(Column::blob("blob").nullable())
        .column(Column::real("real").default(1.5))
        .index("todos_by_text", &["text"])
}

fn derived() -> Table {
    let schema = s::struct_([
        ("id", with_primary_key(&s::string())),
        ("title", s::non_empty_string()),
        ("tags", s::array(s::string())),
        (
            "meta",
            s::optional(s::struct_([("nested", s::struct_([("n", s::int())]))])),
        ),
        ("status", s::literals(["a", "b"])),
        ("at", s::date_from_string()),
        ("maybe", s::null_or(s::struct_([("x", s::number())]))),
    ]);
    Table::from_schema(Some("derived"), &schema, vec![]).unwrap()
}

fn ui_state() -> ClientDocument {
    let value = s::struct_([
        ("newTodoText", s::string()),
        ("filter", s::literals(["all", "active", "completed"])),
    ]);
    ClientDocument::new(
        "uiState",
        value,
        Val::from(json!({ "newTodoText": "", "filter": "all" })),
    )
}

fn settings() -> ClientDocument {
    let value = s::struct_([
        ("theme", s::null_or(s::string())),
        ("sizes", s::array(s::int())),
        ("since", s::date_from_string()),
    ]);
    let default = Val::obj([
        ("theme", Val::Null),
        ("sizes", Val::Array(vec![])),
        ("since", Val::Date(0.0)),
    ]);
    ClientDocument::new("settings", value, default)
        .default_id("global")
        .partial_set(false)
}

fn counter() -> ClientDocument {
    ClientDocument::new("counter", s::number(), 0)
}
