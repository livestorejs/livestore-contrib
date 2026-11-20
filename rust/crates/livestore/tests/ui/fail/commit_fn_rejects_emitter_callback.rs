use livestore::{CommitOptions, Store};

fn _commit(store: &Store) {
    let _ = store.commit_fn(CommitOptions::default(), |emit: fn()| {
        emit();
        Vec::<(String, serde_json::Value)>::new()
    });
}

fn main() {}
