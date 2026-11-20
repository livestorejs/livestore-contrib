use livestore::{CommitOptions, Store};

fn _commit(store: &Store) {
    let _ = store.commit_fn(CommitOptions::default(), || async { Vec::<(String, serde_json::Value)>::new() });
}

fn main() {}
