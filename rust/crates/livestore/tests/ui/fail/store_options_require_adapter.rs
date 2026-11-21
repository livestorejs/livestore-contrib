use std::sync::Arc;

use livestore::StoreOptions;
use livestore_schema::Schema;

fn _options(schema: Arc<Schema>) -> StoreOptions {
    StoreOptions::new(schema, "main")
}

fn main() {}
