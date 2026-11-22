use livestore::{CommitOptions, Event, Store};
use serde::{Deserialize, Serialize};

#[derive(Event, Serialize, Deserialize)]
#[event(name = "v1.TodoCreated")]
struct TodoCreated {
    id: String,
    text: String,
}

#[derive(Event, Serialize, Deserialize)]
#[event(name = "v1.TodoCompleted")]
struct TodoCompleted {
    id: String,
}

fn created() -> TodoCreated {
    TodoCreated { id: "1".into(), text: "Make coffee".into() }
}

fn _commit(store: &Store) {
    let _ = store.commit(created());
    let _ = store.commit((created(), TodoCompleted { id: "1".into() }));
    let _ = store.commit(vec![created(), created()]);
    let _ = store.commit_with(CommitOptions::default(), (created(), TodoCompleted { id: "1".into() }));
}

fn main() {}
