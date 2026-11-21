use livestore_schema::value_schema as s;
use livestore_schema::{ClientDocument, Schema, Val};
use livestore_sqlite::{LocalLeader, session_id_symbol};
use serde_json::{Value, json};

#[test]
fn encodes_commit_events_without_mutating_caller_provided_args() {
    let ui_state = ClientDocument::new(
        "UiState",
        s::struct_([("draft", s::string())]),
        Val::obj([("draft", Val::from(""))]),
    );
    let schema = Schema::builder().client_document(ui_state.clone()).build();
    let mut store = LocalLeader::open_in_memory(schema, "client", "test-session").unwrap();

    let (name, mut args) = ui_state.set(Val::obj([("draft", Val::from("hello"))]), None);
    if let Val::Object(fields) = &mut args {
        fields.insert("id".into(), session_id_symbol());
    }

    store.commit_val(&name, &args).unwrap();

    assert_eq!(args.get("id"), Some(&session_id_symbol()));
    let rows: Vec<Value> =
        livestore_sqlite::db::query_rows(store.db().state_conn(), "SELECT * FROM 'UiState'")
            .unwrap()
            .into_iter()
            .map(Value::Object)
            .collect();
    let value = ui_state
        .get_result_schema()
        .decode(Val::from(Value::Array(rows)))
        .unwrap();
    assert_eq!(value.to_json_value(), json!({"draft": "hello"}));
    let ids = livestore_sqlite::db::query_rows(store.db().state_conn(), "SELECT id FROM 'UiState'")
        .unwrap();
    assert_eq!(
        ids.into_iter().map(Value::Object).collect::<Vec<_>>(),
        vec![json!({"id": "test-session"})]
    );
}
