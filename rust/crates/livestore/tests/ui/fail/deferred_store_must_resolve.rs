use std::sync::Arc;

use livestore::{Adapter, StoreOptions, create_store};
use livestore_schema::Schema;

fn _store(schema: Arc<Schema>, adapter: Adapter) {
    let deferred = create_store(StoreOptions::new(schema, adapter, "main"));
    let _ = deferred.commit(Vec::<(String, serde_json::Value)>::new());
}

fn main() {}
