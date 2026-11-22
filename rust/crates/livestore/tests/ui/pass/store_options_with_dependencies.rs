use std::sync::Arc;

use livestore::{Adapter, StoreOptions, create_store};
use livestore_schema::Schema;

async fn _store(schema: Arc<Schema>, adapter: Adapter) {
    let store = create_store(StoreOptions::new(schema, adapter, "main")).await.unwrap();
    let _ = store.commit(Vec::<livestore::EventInput>::new());
}

fn main() {}
