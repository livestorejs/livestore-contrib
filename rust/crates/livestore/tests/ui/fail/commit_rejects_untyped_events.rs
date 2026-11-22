use livestore::Store;
use serde_json::json;

fn _commit(store: &Store) {
    let _ = store.commit("v1.TodoCreated");
    let _ = store.commit(json!({ "id": "1", "text": "Make coffee" }));
}

fn main() {}
