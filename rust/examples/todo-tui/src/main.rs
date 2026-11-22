//! Terminal `TodoMVC` client (TUI) that syncs with the sync-cf backend (same events as `examples/web-todomvc-sync-cf`).
//!
//! ```text
//! todo --url ws://localhost:8787 --store <id> --data <dir> [--token <authToken>]
//! ```

#![warn(clippy::unwrap_used)]

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use livestore::{
    EventInput, InMemoryAdapter, QueryInput, Store, StoreOptions, SubscribeOptions, create_store,
    query_db,
};
use livestore_schema::event_def::DateFromString;
use livestore_sqlite::Row;
use livestore_sync::{Storage, SyncOptions};
use livestore_sync_cf::make_ws_sync;
use livestore_sync_cf::transport::ClientOptions;
use livestore_todomvc::{
    TodoClearedCompleted, TodoCompleted, TodoCreated, TodoDeleted, TodoUncompleted,
};
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, List, ListItem, ListState, Paragraph};
use ratatui::{DefaultTerminal, Frame};
use serde_json::json;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse()?;
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
    let store = create_store(StoreOptions::new(
        livestore_todomvc::schema(),
        adapter.build(),
        &args.store,
    ))
    .await?;
    let mut terminal = ratatui::init();
    let result = run(&mut terminal, &store, &args.store).await;
    ratatui::restore();
    store.shutdown(None).await;
    result
}

async fn run(
    terminal: &mut DefaultTerminal,
    store: &Store,
    store_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let (keys_tx, mut keys) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        while let Ok(ev) = event::read() {
            if keys_tx.send(ev).is_err() {
                break;
            }
        }
    });
    let (changes_tx, mut changes) = mpsc::unbounded_channel();
    let _todos_changed = store.subscribe(
        &todos_query(),
        move |_| _ = changes_tx.send(()),
        &SubscribeOptions::default(),
    );
    let mut ticker = tokio::time::interval(Duration::from_millis(500));
    let mut app = App {
        store_id: store_id.to_owned(),
        ..App::default()
    };
    loop {
        app.todos = visible(store);
        app.clamp();
        terminal.draw(|f| draw(f, &mut app, store))?;
        tokio::select! {
            Some(ev) = keys.recv() => {
                if let Event::Key(key) = ev && key.kind == KeyEventKind::Press {
                    app.error = None;
                    match handle(&mut app, store, key.code, key.modifiers) {
                        Ok(Flow::Quit) => return Ok(()),
                        Ok(Flow::Continue) => {}
                        Err(e) => app.error = Some(e.to_string()),
                    }
                }
            }
            Some(()) = changes.recv() => {}
            _ = ticker.tick() => {}
        }
    }
}

#[derive(Default, Clone, Copy, PartialEq)]
enum Filter {
    #[default]
    All,
    Active,
    Completed,
}

#[derive(Default, PartialEq)]
enum Focus {
    #[default]
    Input,
    List,
}

#[derive(Default)]
struct App {
    store_id: String,
    todos: Vec<Row>,
    input: String,
    filter: Filter,
    focus: Focus,
    list: ListState,
    error: Option<String>,
}

impl App {
    fn shown(&self) -> Vec<&Row> {
        self.todos
            .iter()
            .filter(|r| match self.filter {
                Filter::All => true,
                Filter::Active => r["completed"] != 1,
                Filter::Completed => r["completed"] == 1,
            })
            .collect()
    }

    fn selected_id(&self) -> Option<String> {
        let shown = self.shown();
        self.list
            .selected()
            .and_then(|i| shown.get(i))
            .and_then(|r| r["id"].as_str())
            .map(str::to_owned)
    }

    fn clamp(&mut self) {
        let n = self.shown().len();
        match (n, self.list.selected()) {
            (0, _) => self.list.select(None),
            (_, None) => self.list.select(Some(0)),
            (_, Some(i)) if i >= n => self.list.select(Some(n - 1)),
            _ => {}
        }
    }
}

enum Flow {
    Continue,
    Quit,
}

fn handle(
    app: &mut App,
    store: &Store,
    code: KeyCode,
    mods: KeyModifiers,
) -> Result<Flow, Box<dyn std::error::Error>> {
    if mods.contains(KeyModifiers::CONTROL) && code == KeyCode::Char('c') {
        return Ok(Flow::Quit);
    }
    if code == KeyCode::Tab {
        app.focus = if app.focus == Focus::Input {
            Focus::List
        } else {
            Focus::Input
        };
        return Ok(Flow::Continue);
    }
    if app.focus == Focus::Input {
        match code {
            KeyCode::Enter if !app.input.trim().is_empty() => {
                store.commit(TodoCreated {
                    id: random_id(),
                    text: app.input.trim().to_owned(),
                })?;
                app.input.clear();
            }
            KeyCode::Char(c) => app.input.push(c),
            KeyCode::Backspace => _ = app.input.pop(),
            KeyCode::Esc | KeyCode::Down => app.focus = Focus::List,
            _ => {}
        }
        return Ok(Flow::Continue);
    }
    match code {
        KeyCode::Char('q') => return Ok(Flow::Quit),
        KeyCode::Char('i' | 'n') => app.focus = Focus::Input,
        KeyCode::Up | KeyCode::Char('k') => {
            if app.list.selected() == Some(0) {
                app.focus = Focus::Input;
            } else {
                app.list.select_previous();
            }
        }
        KeyCode::Down | KeyCode::Char('j') => app.list.select_next(),
        KeyCode::Char(' ') | KeyCode::Enter => {
            if let Some(id) = app.selected_id() {
                let done = app
                    .shown()
                    .iter()
                    .any(|r| r["id"] == id.as_str() && r["completed"] == 1);
                let event = if done {
                    TodoUncompleted { id }.into()
                } else {
                    EventInput::from(TodoCompleted { id })
                };
                store.commit(event)?;
            }
        }
        KeyCode::Char('d' | 'x') | KeyCode::Delete | KeyCode::Backspace => {
            if let Some(id) = app.selected_id() {
                store.commit(TodoDeleted {
                    id,
                    deleted_at: DateFromString::now(),
                })?;
            }
        }
        KeyCode::Char('c') => store.commit(TodoClearedCompleted {
            deleted_at: DateFromString::now(),
        })?,
        KeyCode::Char('1') => app.filter = Filter::All,
        KeyCode::Char('2') => app.filter = Filter::Active,
        KeyCode::Char('3') => app.filter = Filter::Completed,
        KeyCode::Left => app.filter = cycle(app.filter, false),
        KeyCode::Right => app.filter = cycle(app.filter, true),
        _ => {}
    }
    Ok(Flow::Continue)
}

#[expect(
    clippy::too_many_lines,
    reason = "the whole screen layout reads best in one place"
)]
fn draw(f: &mut Frame, app: &mut App, store: &Store) {
    let [title, input, list, footer, status, help] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(3),
        Constraint::Min(3),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(f.area());

    f.render_widget(
        Line::from(vec![
            "todos".bold().fg(Color::Red),
            format!("  store: {}", app.store_id).dark_gray(),
        ])
        .centered(),
        title,
    );

    let input_focused = app.focus == Focus::Input;
    let input_text = if app.input.is_empty() && !input_focused {
        Span::from("What needs to be done?").dark_gray().italic()
    } else {
        Span::from(app.input.as_str())
    };
    f.render_widget(
        Paragraph::new(input_text).block(
            Block::bordered()
                .border_style(focus_style(input_focused))
                .title(" new todo "),
        ),
        input,
    );
    if input_focused {
        let typed = u16::try_from(app.input.chars().count()).unwrap_or(u16::MAX);
        f.set_cursor_position((input.x.saturating_add(1).saturating_add(typed), input.y + 1));
    }

    let items: Vec<ListItem> = app
        .shown()
        .iter()
        .map(|r| {
            let text = r["text"].as_str().unwrap_or("").to_owned();
            if r["completed"] == 1 {
                ListItem::new(Line::from(vec![
                    "[x] ".green(),
                    Span::from(text).dark_gray().crossed_out(),
                ]))
            } else {
                ListItem::new(Line::from(vec!["[ ] ".into(), Span::from(text)]))
            }
        })
        .collect();
    let list_focused = app.focus == Focus::List;
    let list_widget = List::new(items)
        .block(Block::bordered().border_style(focus_style(list_focused)))
        .highlight_style(if list_focused {
            Style::new().add_modifier(Modifier::REVERSED)
        } else {
            Style::new()
        })
        .highlight_symbol("> ");
    f.render_stateful_widget(list_widget, list, &mut app.list);

    let left = app.todos.iter().filter(|r| r["completed"] != 1).count();
    let tab = |label: &str, filter: Filter| {
        let span = Span::from(format!(" {label} "));
        if app.filter == filter {
            span.reversed()
        } else {
            span
        }
    };
    f.render_widget(
        Line::from(vec![
            format!(
                "{left} {} left   ",
                if left == 1 { "item" } else { "items" }
            )
            .into(),
            tab("1 All", Filter::All),
            tab("2 Active", Filter::Active),
            tab("3 Completed", Filter::Completed),
        ]),
        footer,
    );

    let info = store.sync_status();
    let conn = if *store.network_status().borrow() {
        "connected".green()
    } else {
        "offline".yellow()
    };
    let mut parts = vec![
        conn,
        format!(
            "  local {}  upstream {}  pending {}",
            info.local_head, info.upstream_head, info.pending_count
        )
        .dark_gray(),
    ];
    let stopped = store.is_shutdown().then(|| "store stopped".to_owned());
    if let Some(err) = app.error.clone().or(stopped) {
        parts.push(format!("  {err}").red());
    }
    f.render_widget(Line::from(parts), status);

    let keys = if input_focused {
        "enter add · tab/esc/↓ list · ctrl-c quit"
    } else {
        "↑↓/jk move · space toggle · d delete · c clear completed · 1-3/←→ filter · tab/i new · q quit"
    };
    f.render_widget(Line::from(keys).dark_gray(), help);
}

fn focus_style(focused: bool) -> Style {
    if focused {
        Style::new().fg(Color::Cyan)
    } else {
        Style::new().dark_gray()
    }
}

fn cycle(filter: Filter, forward: bool) -> Filter {
    let all = [Filter::All, Filter::Active, Filter::Completed];
    let i = all.iter().position(|f| *f == filter).unwrap_or(0);
    all[if forward { (i + 1) % 3 } else { (i + 2) % 3 }]
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
        let usage =
            "usage: todo --url ws://localhost:8787 --store <id> --data <dir> [--token <authToken>]";
        Ok(Args {
            url: url.ok_or(usage)?,
            store: store.ok_or(usage)?,
            data: data.ok_or(usage)?,
            token,
        })
    }
}

fn visible(store: &Store) -> Vec<Row> {
    store.query(&todos_query())
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
