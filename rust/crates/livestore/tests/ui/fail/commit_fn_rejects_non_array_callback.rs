use livestore::{CommitOptions, Store};

fn _commit(store: &Store) {
    let _ = store.commit_fn(CommitOptions::default(), || {});
}

fn main() {}
