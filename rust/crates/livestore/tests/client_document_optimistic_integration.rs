//! Port of `tests/package-common/src/client-document-optimistic-integration.test.ts`.

mod common;

use std::sync::Arc;

use livestore::{
    InMemoryAdapter, SESSION_ID_SYMBOL, Store, StoreOptions, client_document_get, create_store,
};
use livestore_schema::value_schema as s;
use livestore_schema::{ClientDocument, Schema, Val};
use serde_json::{Value, json};

#[tokio::test]
async fn handles_schema_evolution_gracefully() {
    let v1 = ClientDocument::new(
        "Settings",
        s::struct_([("theme", s::string())]),
        Val::from(json!({ "theme": "light" })),
    )
    .default_id(SESSION_ID_SYMBOL);
    let store1 = open(&v1, "test", None).await;
    commit_set(&store1, &v1, json!({ "theme": "dark" }));
    let snapshot = store1.sqlite_db_wrapper().export().unwrap();

    let v2 = ClientDocument::new(
        "Settings",
        s::struct_([("theme", s::string()), ("fontSize", s::finite())]),
        Val::from(json!({ "theme": "light", "fontSize": 14 })),
    )
    .default_id(SESSION_ID_SYMBOL);
    let store2 = open(&v2, "test", Some(snapshot)).await;
    let result = store2.query(&client_document_get(&v2, None));
    assert_eq!(result["theme"], "dark");
    assert_eq!(result["fontSize"], 14);
}

#[tokio::test]
async fn handles_field_removal() {
    let v1 = ClientDocument::new(
        "Config",
        s::struct_([("apiUrl", s::string()), ("apiKey", s::string())]),
        Val::from(json!({ "apiUrl": "https://api.example.com", "apiKey": "secret" })),
    )
    .default_id(SESSION_ID_SYMBOL);
    let store1 = open(&v1, "test-removal", None).await;
    commit_set(
        &store1,
        &v1,
        json!({ "apiUrl": "https://prod.api.com", "apiKey": "prod-key" }),
    );
    let snapshot = store1.sqlite_db_wrapper().export().unwrap();

    let v2 = ClientDocument::new(
        "Config",
        s::struct_([("apiUrl", s::string())]),
        Val::from(json!({ "apiUrl": "https://api.example.com" })),
    )
    .default_id(SESSION_ID_SYMBOL);
    let store2 = open(&v2, "test-removal", Some(snapshot)).await;
    let result = store2.query(&client_document_get(&v2, None));
    assert_eq!(result["apiUrl"], "https://prod.api.com");
    assert!(result.get("apiKey").is_none());
}

async fn open(doc: &ClientDocument, store_id: &str, import_snapshot: Option<Vec<u8>>) -> Store {
    let schema: Arc<Schema> = Schema::builder().client_document(doc.clone()).build();
    let adapter = InMemoryAdapter {
        import_snapshot,
        ..InMemoryAdapter::default()
    };
    create_store(StoreOptions::new(schema, adapter.build(), store_id))
        .await
        .unwrap()
}

fn commit_set(store: &Store, doc: &ClientDocument, value: Value) {
    store.commit([doc.set(Val::from(value), None)]).unwrap();
}
