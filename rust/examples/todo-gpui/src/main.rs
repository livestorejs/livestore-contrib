//! Desktop `TodoMVC` client (GPUI) that syncs with the sync-cf backend (same events as `examples/web-todomvc-sync-cf`).
//!
//! ```text
//! todo-gpui --url ws://localhost:8787 --store <id> --data <dir> [--token <authToken>]
//! ```
//!
//! GPUI owns the main thread and has no tokio, so the store lives on a tokio runtime in a
//! background thread. Every window shares the same `Store` handle (cmd-N opens another).

#![warn(clippy::unwrap_used)]

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    App, Application, Bounds, ClickEvent, Context, Div, FocusHandle, KeyBinding, KeyDownEvent,
    Menu, MenuItem, SharedString, Stateful, Window, WindowBounds, WindowOptions, actions, div,
    prelude::*, px, rgb, size,
};
use livestore::{
    EventInput, Events, InMemoryAdapter, QueryInput, Store, StoreOptions, SubscribeOptions,
    Subscription, create_store, query_db,
};
use livestore_schema::event_def::DateFromString;
use livestore_sqlite::Row;
use livestore_sync::{Storage, SyncOptions};
use livestore_sync_cf::make_ws_sync;
use livestore_sync_cf::transport::ClientOptions;
use livestore_todomvc::{
    TodoClearedCompleted, TodoCompleted, TodoCreated, TodoDeleted, TodoUncompleted,
};
use serde_json::json;

const TITLE: &str = "LiveStore · GPUI";

actions!(todo_gpui, [NewWindow, Quit]);

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse()?;
    let store = start_store(args)?;
    Application::new().run(move |cx: &mut App| {
        cx.bind_keys([
            KeyBinding::new("cmd-n", NewWindow, None),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.set_menus(vec![Menu {
            name: "Todo".into(),
            items: vec![
                MenuItem::action("New Window", NewWindow),
                MenuItem::action("Quit", Quit),
            ],
        }]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        let for_new = store.clone();
        cx.on_action(move |_: &NewWindow, cx| open_window(&for_new, cx));
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        open_window(&store, cx);
        cx.activate(true);
    });
    Ok(())
}

/// Creates the store on a dedicated tokio runtime and keeps that runtime running for the app's lifetime.
fn start_store(args: Args) -> Result<Store, Box<dyn std::error::Error>> {
    let dir = args.data.join(&args.store);
    std::fs::create_dir_all(&dir)?;
    let client_id = client_id(&dir)?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(e) => {
                _ = tx.send(Err(e.to_string()));
                return;
            }
        };
        runtime.block_on(async move {
            let (url, token, folder) = (args.url, args.token, dir);
            let adapter = InMemoryAdapter {
                client_id,
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
            let store = create_store(StoreOptions::new(
                livestore_todomvc::schema(),
                adapter.build(),
                &args.store,
            ))
            .await
            .map_err(|e| e.to_string());
            _ = tx.send(store);
            std::future::pending::<()>().await;
        });
    });
    Ok(rx.recv()??)
}

fn open_window(store: &Store, cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(560.), px(680.)), cx);
    let store = store.clone();
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some(TITLE.into()),
                ..gpui::TitlebarOptions::default()
            }),
            ..WindowOptions::default()
        },
        |window, cx| cx.new(|cx| TodoView::new(store, window, cx)),
    );
    if let Err(e) = opened {
        eprintln!("failed to open window: {e}");
    }
}

#[derive(Default, Clone, Copy, PartialEq)]
enum Filter {
    #[default]
    All,
    Active,
    Completed,
}

struct TodoView {
    store: Store,
    todos: Vec<Row>,
    input: String,
    filter: Filter,
    error: Option<String>,
    focus: FocusHandle,
    _subscription: Subscription,
}

impl TodoView {
    fn new(store: Store, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (changes_tx, mut changes) = tokio::sync::mpsc::unbounded_channel();
        let subscription = store.subscribe(
            &todos_query(),
            move |_| _ = changes_tx.send(()),
            &SubscribeOptions::default(),
        );
        cx.spawn(async move |this, cx| {
            while changes.recv().await.is_some() {
                let refreshed = this.update(cx, |this, cx| {
                    this.todos = this.store.query(&todos_query());
                    cx.notify();
                });
                if refreshed.is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        let focus = cx.focus_handle();
        window.focus(&focus);
        Self {
            todos: store.query(&todos_query()),
            store,
            input: String::new(),
            filter: Filter::All,
            error: None,
            focus,
            _subscription: subscription,
        }
    }

    fn commit(&mut self, event: impl Events, cx: &mut Context<Self>) {
        self.error = self.store.commit(event).err().map(|e| e.to_string());
        cx.notify();
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &ev.keystroke;
        if keystroke.modifiers.platform || keystroke.modifiers.control {
            return;
        }
        match keystroke.key.as_str() {
            "enter" => {
                let text = self.input.trim().to_owned();
                if !text.is_empty() {
                    self.input.clear();
                    self.commit(
                        TodoCreated {
                            id: random_id(),
                            text,
                        },
                        cx,
                    );
                }
            }
            "backspace" => _ = self.input.pop(),
            "escape" => self.input.clear(),
            _ => {
                if let Some(typed) = &keystroke.key_char {
                    self.input.push_str(typed);
                }
            }
        }
        cx.notify();
    }

    fn row(row: &Row, cx: &mut Context<Self>) -> Stateful<Div> {
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        let done = row["completed"] == 1;
        let text = SharedString::from(row["text"].as_str().unwrap_or_default().to_owned());
        let toggle_id = id.clone();
        let delete_id = id.clone();
        div()
            .id(SharedString::from(id))
            .group("row")
            .flex()
            .items_center()
            .gap_3()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(rgb(0x00ed_eded))
            .child(
                div()
                    .id("toggle")
                    .size(px(22.))
                    .rounded_full()
                    .border_1()
                    .border_color(if done {
                        rgb(0x005d_c2af)
                    } else {
                        rgb(0x00cc_cccc)
                    })
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(0x005d_c2af))
                    .text_sm()
                    .cursor_pointer()
                    .child(if done { "✓" } else { "" })
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        let id = toggle_id.clone();
                        let event = if done {
                            TodoUncompleted { id }.into()
                        } else {
                            EventInput::from(TodoCompleted { id })
                        };
                        this.commit(event, cx);
                    })),
            )
            .child(
                div()
                    .flex_1()
                    .text_color(if done {
                        rgb(0x00b0_b0b0)
                    } else {
                        rgb(0x0033_3333)
                    })
                    .when(done, gpui::Styled::line_through)
                    .child(text),
            )
            .child(
                div()
                    .id("delete")
                    .invisible()
                    .group_hover("row", gpui::Styled::visible)
                    .text_color(rgb(0x00c1_8585))
                    .cursor_pointer()
                    .child("×")
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.commit(
                            TodoDeleted {
                                id: delete_id.clone(),
                                deleted_at: DateFromString::now(),
                            },
                            cx,
                        );
                    })),
            )
    }

    fn filter_button(
        &self,
        label: &'static str,
        filter: Filter,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        div()
            .id(label)
            .px_2()
            .rounded_sm()
            .border_1()
            .border_color(if self.filter == filter {
                rgb(0x00e0_b4b4).into()
            } else {
                gpui::transparent_black()
            })
            .cursor_pointer()
            .child(label)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.filter = filter;
                cx.notify();
            }))
    }
}

impl Render for TodoView {
    #[expect(
        clippy::too_many_lines,
        reason = "the whole window layout reads best in one place"
    )]
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shown: Vec<Row> = self
            .todos
            .iter()
            .filter(|r| match self.filter {
                Filter::All => true,
                Filter::Active => r["completed"] != 1,
                Filter::Completed => r["completed"] == 1,
            })
            .cloned()
            .collect();
        let left = self.todos.iter().filter(|r| r["completed"] != 1).count();
        let rows: Vec<_> = shown.iter().map(|r| Self::row(r, cx)).collect();
        let input = if self.input.is_empty() {
            div()
                .text_color(rgb(0x00bb_bbbb))
                .italic()
                .child("What needs to be done?")
        } else {
            div().child(format!("{}▏", self.input))
        };
        let sync = self.store.sync_status();
        let connected = *self.store.network_status().borrow();
        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0x00f5_f5f5))
            .text_color(rgb(0x0033_3333))
            .p_6()
            .gap_4()
            .child(
                div()
                    .flex()
                    .justify_center()
                    .text_3xl()
                    .font_weight(gpui::FontWeight::BOLD)
                    .text_color(rgb(0x00b8_3f45))
                    .child(TITLE),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .bg(rgb(0x00ff_ffff))
                    .rounded_md()
                    .shadow_md()
                    .overflow_hidden()
                    .child(
                        div()
                            .px_4()
                            .py_3()
                            .text_lg()
                            .border_b_1()
                            .border_color(rgb(0x00e6_e6e6))
                            .child(input),
                    )
                    .child(div().id("list").flex_1().overflow_y_scroll().children(rows))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .px_4()
                            .py_2()
                            .text_sm()
                            .text_color(rgb(0x0077_7777))
                            .border_t_1()
                            .border_color(rgb(0x00e6_e6e6))
                            .child(format!(
                                "{left} {} left",
                                if left == 1 { "item" } else { "items" }
                            ))
                            .child(
                                div()
                                    .flex()
                                    .gap_1()
                                    .child(self.filter_button("All", Filter::All, cx))
                                    .child(self.filter_button("Active", Filter::Active, cx))
                                    .child(self.filter_button("Completed", Filter::Completed, cx)),
                            )
                            .child(
                                div()
                                    .id("clear")
                                    .cursor_pointer()
                                    .child("Clear completed")
                                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                        this.commit(
                                            TodoClearedCompleted {
                                                deleted_at: DateFromString::now(),
                                            },
                                            cx,
                                        );
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .gap_3()
                    .text_xs()
                    .text_color(rgb(0x0099_9999))
                    .child(
                        div()
                            .text_color(if connected {
                                rgb(0x0021_9653)
                            } else {
                                rgb(0x00c0_8a00)
                            })
                            .child(if connected {
                                "● connected"
                            } else {
                                "● offline"
                            }),
                    )
                    .child(format!("pending {}", sync.pending_count))
                    .child(format!("head {}", sync.local_head))
                    .when_some(self.error.clone(), |el, err| {
                        el.child(div().text_color(rgb(0x00c0_3030)).child(err))
                    })
                    .when(self.store.is_shutdown(), |el| {
                        el.child(div().text_color(rgb(0x00c0_3030)).child("store stopped"))
                    }),
            )
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
        let usage = "usage: todo-gpui --url ws://localhost:8787 --store <id> --data <dir> [--token <authToken>]";
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
