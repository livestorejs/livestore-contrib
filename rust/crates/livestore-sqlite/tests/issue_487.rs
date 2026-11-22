use livestore_schema::value_schema as s;
use livestore_schema::{ClientDocument, Schema, Val};
use livestore_sqlite::{LocalLeader, session_id_symbol};
use serde_json::Value;

#[test]
fn reproduces_livestore_optional_field_bug_repo_scenario() {
    let ui_state = ClientDocument::new(
        "UiState",
        s::struct_([
            ("newTodoText", s::string()),
            ("description", s::optional(s::string())),
            ("filter", s::literals(["all", "active", "completed"])),
        ]),
        Val::obj([("newTodoText", Val::from("")), ("filter", Val::from("all"))]),
    );
    let schema = Schema::builder().client_document(ui_state.clone()).build();
    let mut store = LocalLeader::open_in_memory(schema, "client", "session").unwrap();

    let name = ui_state.set_event_name();
    let mut args = ui_state.set_args(
        Val::obj([
            ("newTodoText", Val::from("")),
            ("description", Val::from("First attempt")),
            ("filter", Val::from("all")),
        ]),
        None,
    );
    if let Val::Object(fields) = &mut args {
        fields.insert("id".into(), session_id_symbol());
    }
    store.commit_val(&name, &args).unwrap();

    let rows: Vec<Value> = livestore_sqlite::db::query_rows(
        store.db().state_conn(),
        "SELECT * FROM 'UiState' WHERE id = 'session'",
    )
    .unwrap()
    .into_iter()
    .map(Value::Object)
    .collect();
    let result = ui_state
        .get_result_schema()
        .decode(Val::from(Value::Array(rows)))
        .unwrap();

    assert_eq!(result.get("newTodoText"), Some(&Val::from("")));
    assert_eq!(result.get("description"), Some(&Val::from("First attempt")));
    assert_eq!(result.get("filter"), Some(&Val::from("all")));
}
