//! Desktop `TodoMVC` (rune GUI) that syncs with the sync-cf backend (same events as `examples/web-todomvc-sync-cf`).
//!
//! ```text
//! todo-rune --url ws://localhost:8787 --store <id> --data <dir> [--token <authToken>]
//! ```

#![warn(clippy::unwrap_used)]

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livestore::{
    InMemoryAdapter, QueryInput, Store, StoreOptions, SubscribeOptions, create_store, query_db,
};
use livestore_schema::codec::iso_string_from_millis;
use livestore_sqlite::Row;
use livestore_sync::{Storage, SyncOptions};
use livestore_sync_cf::make_ws_sync;
use livestore_sync_cf::transport::ClientOptions;
use rune::tok::{self, Theme, radius, space, type_};
use rune::{App, AppHandle, AppSpec, Cx, El, TextEdit, Tx, col, el, row, text, text_input};
use serde_json::{Value, json};

const APP_TITLE: &str = "LiveStore · rune";

fn main() {
    let args = match Args::parse() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let app = App::new(AppSpec::new(
        APP_TITLE,
        (520.0, 640.0),
        State::default,
        view,
    ));
    let handle = app.handle();
    std::thread::spawn(move || run_store(&args, &handle));
    app.run();
}

/// Owns the tokio runtime the store needs; feeds query results and sync status into the UI.
fn run_store(args: &Args, ui: &AppHandle<State>) {
    let result = tokio::runtime::Runtime::new()
        .map_err(|e| e.to_string())
        .and_then(|rt| rt.block_on(serve(args, ui)));
    if let Err(e) = result {
        ui.update(move |s, _| s.error = Some(e));
    }
}

async fn serve(args: &Args, ui: &AppHandle<State>) -> Result<(), String> {
    let store = open_store(args).await.map_err(|e| e.to_string())?;
    let (ui_store, store_id) = (store.clone(), args.store.clone());
    ui.update(move |s, _| {
        s.store = Some(ui_store);
        s.store_id = store_id;
    });
    let on_change = ui.clone();
    let _todos = store.subscribe(
        &todos_query(),
        move |rows| on_change.update(move |s, _| s.todos = rows),
        &SubscribeOptions::default(),
    );
    loop {
        let info = store.sync_status();
        let online = *store.network_status().borrow();
        let status = format!(
            "{}  ·  local {}  upstream {}  pending {}",
            if online { "connected" } else { "offline" },
            info.local_head,
            info.upstream_head,
            info.pending_count
        );
        ui.update_if(move |s, _| {
            let changed = s.status != status || s.online != online;
            s.status = status;
            s.online = online;
            changed
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn open_store(args: &Args) -> Result<Store, Box<dyn std::error::Error>> {
    let dir = args.data.join(&args.store);
    std::fs::create_dir_all(&dir)?;
    let (url, token, folder) = (args.url.clone(), args.token.clone(), dir.clone());
    let adapter = InMemoryAdapter {
        client_id: client_id(&dir)?,
        session_id: random_id(),
        leader_builder: Some(Arc::new(move |builder| {
            builder
                .sync_payload(json!({"authToken": token}))
                .storage(Storage::Folder(folder.clone()))
                .sync(SyncOptions {
                    backend: Some(make_ws_sync(&url, ClientOptions::default())),
                    ..SyncOptions::default()
                })
        })),
        ..InMemoryAdapter::default()
    };
    Ok(create_store(StoreOptions::new(
        livestore_todomvc::schema(),
        adapter.build(),
        &args.store,
    ))
    .await?)
}

#[derive(Default, Clone, Copy, PartialEq)]
enum Filter {
    #[default]
    All,
    Active,
    Completed,
}

struct State {
    store: Option<Store>,
    store_id: String,
    todos: Vec<Row>,
    draft: TextEdit,
    filter: Filter,
    status: String,
    online: bool,
    error: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        State {
            store: None,
            store_id: String::new(),
            todos: Vec::new(),
            draft: TextEdit::new(""),
            filter: Filter::All,
            status: "starting…".to_owned(),
            online: false,
            error: None,
        }
    }
}

impl State {
    fn commit(&mut self, name: &str, args: Value) {
        let Some(store) = &self.store else { return };
        self.error = store
            .commit([(name.to_owned(), args)])
            .err()
            .map(|e| e.to_string());
    }
}

fn view(s: &State, cx: &mut Cx<State>) -> El {
    let t = tok::theme(cx.system_dark());
    let input = text_input(&s.draft, type_::BODY)
        .key("new-todo")
        .label("New todo")
        .placeholder("What needs to be done?", t.text_secondary)
        .color(t.text)
        .w_full()
        .h(44.0)
        .padding(12.0)
        .radius(radius::MD)
        .fill(t.card)
        .border(1.0, t.card_border)
        .on_edit(|s: &mut State| &mut s.draft)
        .on_submit(add_todo);

    let mut list = col().key("list").gap(space::S1);
    for todo in s.todos.iter().filter(|r| match s.filter {
        Filter::All => true,
        Filter::Active => r["completed"] != 1,
        Filter::Completed => r["completed"] == 1,
    }) {
        list = list.child(todo_row(todo, t));
    }

    let left = s.todos.iter().filter(|r| r["completed"] != 1).count();
    let footer = row()
        .key("footer")
        .w_full()
        .gap(space::S2)
        .center_y()
        .child(
            text(format!(
                "{left} {} left",
                if left == 1 { "item" } else { "items" }
            ))
            .font(type_::LABEL)
            .color(t.text_secondary)
            .grow(1.0),
        )
        .child(filter_tab("All", Filter::All, s.filter, t))
        .child(filter_tab("Active", Filter::Active, s.filter, t))
        .child(filter_tab("Completed", Filter::Completed, s.filter, t))
        .child(
            button("clear", "Clear completed", t).on_press(|s: &mut State| {
                s.commit("v1.TodoClearedCompleted", json!({"deletedAt": now_iso()}));
            }),
        );

    let status_color = if s.online {
        tok::accent(0, true)
    } else {
        t.text_secondary
    };
    let mut status = row()
        .key("status")
        .w_full()
        .gap(space::S2)
        .child(
            text(s.status.clone())
                .font(type_::LABEL)
                .color(status_color),
        )
        .child(
            text(format!("store {}", s.store_id))
                .font(type_::LABEL)
                .color(t.text_secondary),
        );
    if let Some(err) = &s.error {
        status = status.child(
            text(err.clone())
                .font(type_::LABEL)
                .color(rune::oklch(0.65, 0.2, 25.0)),
        );
    }

    col()
        .key("window")
        .w_full()
        .h_full()
        .padding(space::S6)
        .gap(space::S3)
        .fill(t.bg)
        .child(
            text(APP_TITLE)
                .key("title")
                .font(rune::TextStyle::new(28.0, 700.0))
                .color(t.text),
        )
        .child(input)
        .child(
            list.scroll(rune::ScrollSpec {
                stick_bottom: false,
            })
            .grow(1.0)
            .shrink()
            .min_h(0.0),
        )
        .child(footer)
        .child(status)
}

fn todo_row(todo: &Row, t: Theme) -> El {
    let id = todo["id"].as_str().unwrap_or_default().to_owned();
    let done = todo["completed"] == 1;
    let toggle_id = id.clone();
    let check = el()
        .key("check")
        .role("checkbox")
        .size(18.0, 18.0)
        .radius(9.0)
        .fill(if done {
            tok::accent(0, true)
        } else {
            t.control_off
        })
        .on_press(move |s: &mut State| {
            let name = if done {
                "v1.TodoUncompleted"
            } else {
                "v1.TodoCompleted"
            };
            s.commit(name, json!({"id": toggle_id}));
        });
    let title = text(todo["text"].as_str().unwrap_or_default().to_owned())
        .font(type_::BODY)
        .grow(1.0)
        .color(if done { t.text_secondary } else { t.text });
    let delete_id = id.clone();
    let delete = text("Delete")
        .key("delete")
        .role("button")
        .font(type_::LABEL)
        .color(t.text_secondary)
        .on_press(move |s: &mut State| {
            s.commit(
                "v1.TodoDeleted",
                json!({"id": delete_id, "deletedAt": now_iso()}),
            );
        });
    row()
        .key(format!("todo-{id}"))
        .h(40.0)
        .px(space::S3)
        .gap(space::S3)
        .center_y()
        .radius(radius::SM)
        .fill(t.card)
        .child(check)
        .child(title)
        .child(delete)
}

fn filter_tab(label: &'static str, filter: Filter, current: Filter, t: Theme) -> El {
    let b = button(label, label, t).on_press(move |s: &mut State| s.filter = filter);
    if filter == current {
        b.border(1.0, tok::accent(0, true))
    } else {
        b
    }
}

fn button(key: &'static str, label: &'static str, t: Theme) -> El {
    row()
        .key(key)
        .role("button")
        .label(label)
        .h(28.0)
        .px(space::S2)
        .center()
        .radius(radius::MD)
        .fill(t.card)
        .border(1.0, t.card_border)
        .child(text(label).font(type_::LABEL).color(t.text))
}

fn add_todo(s: &mut State, _: &mut Tx) {
    let title = s.draft.text.trim().to_owned();
    if title.is_empty() {
        return;
    }
    s.commit("v1.TodoCreated", json!({"id": random_id(), "text": title}));
    if s.error.is_none() {
        s.draft.clear();
    }
}

struct Args {
    url: String,
    store: String,
    data: PathBuf,
    token: String,
}

impl Args {
    fn parse() -> Result<Args, String> {
        let mut url = None;
        let mut store = None;
        let mut data = None;
        let mut token = "insecure-token-change-me".to_owned();
        let mut it = std::env::args().skip(1);
        while let Some(flag) = it.next() {
            let value = it.next().ok_or(format!("missing value for {flag}"))?;
            match flag.as_str() {
                "--url" => url = Some(value),
                "--store" => store = Some(value),
                "--data" => data = Some(PathBuf::from(value)),
                "--token" => token = value,
                _ => return Err(format!("unknown flag {flag}")),
            }
        }
        let usage = "usage: todo-rune --url ws://localhost:8787 --store <id> --data <dir> [--token <authToken>]";
        Ok(Args {
            url: url.ok_or(usage)?,
            store: store.ok_or(usage)?,
            data: data.ok_or(usage)?,
            token,
        })
    }
}

fn todos_query() -> livestore::DbQueryDef<Vec<Row>> {
    query_db(QueryInput::sql(
        "SELECT id, text, completed FROM todos WHERE deletedAt IS NULL ORDER BY rowid",
    ))
}

/// Stable per data dir, like the TS client id kept in storage.
fn client_id(dir: &Path) -> std::io::Result<String> {
    let path = dir.join("client-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        Ok(id.trim().to_owned())
    } else {
        let id = random_id()[..8].to_owned();
        std::fs::write(&path, &id)?;
        Ok(id)
    }
}

/// UUID v4 shape (`crypto.randomUUID()` in the web app), from the std hasher's random keys.
fn random_id() -> String {
    let (a, b) = (
        RandomState::new().hash_one(0u8),
        RandomState::new().hash_one(1u8),
    );
    let b = (b & 0x3fff_ffff_ffff_ffff) | 0x8000_0000_0000_0000;
    let a = (a & 0xffff_ffff_ffff_0fff) | 0x4000;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        a >> 32,
        (a >> 16) & 0xffff,
        a & 0xffff,
        b >> 48,
        b & 0xffff_ffff_ffff
    )
}

/// `new Date().toISOString()`.
fn now_iso() -> Value {
    iso_string_from_millis(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the system clock is after 1970")
            .as_millis()
            .try_into()
            .expect("milliseconds since 1970 fit in i64"),
    )
    .into()
}
