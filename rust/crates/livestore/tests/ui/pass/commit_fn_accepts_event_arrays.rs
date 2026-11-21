use livestore::{CommitOptions, Store};
use serde_json::json;

fn _commit(store: &Store) {
    let _ = store.commit_fn(CommitOptions::default(), || vec![("v1.TodoCreated".to_string(), json!({ "id": "1", "text": "Make coffee" }))]);
    let _ = store.commit_fn(CommitOptions::default(), Vec::<(String, serde_json::Value)>::new);
}

fn main() {}
