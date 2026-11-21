# Rust client examples

Apps built on the Rust client. Each example is its own Cargo workspace with its own
`Cargo.lock`, so UI dependencies never enter the client's build and examples cannot
conflict with each other. They use the client crates through path dependencies
(`../../crates/*`).

| Example | UI | Shows |
|---|---|---|
| `todo-tui` | ratatui (terminal) | An app that already runs tokio |
| `todo-gpui` | GPUI | An app without tokio; Cmd-N opens a second window on the same store |
| `todo-rune` | rune | An Elm-style app whose UI thread must not block; results arrive through `AppHandle::update` |

All three are TodoMVC on the `livestore-todomvc` schema, so they sync with core's web TodoMVC.

## Try them together

1. In a core checkout, start the web TodoMVC with its sync server:
   `cd examples/web-todomvc-sync-cf && pnpm dev`, then open
   http://localhost:60001/?storeId=rust-demo.
2. Here, start any of `./run-tui.sh`, `./run-gpui.sh` and `./run-rune.sh`. They default to
   the store `rust-demo` and the sync server at `ws://localhost:60001/sync`. Each keeps its
   data in `.data/<app>`. Override with `STORE`, `URL`, `DATA` or `CLIENT` (a second client
   of the same app, for example `CLIENT=2 ./run-tui.sh`).

Checks: `devenv tasks run rust:examples` (format and clippy for each example).

## `todo-tui`: terminal TodoMVC

```bash
cd rust/examples
cargo run --bin todo -- --url ws://localhost:8787 --store my-store --data ./data [--token <authToken>]
```

Commands: `add <text>`, `done <n|id>`, `undo <n|id>`, `rm <n|id>`, `clear` (clear completed), `list`,
`status`, `quit`. `<n>` is the number shown in the list; an id prefix works too. Remote changes print
as they arrive. Local data lives in `<data>/<store>/` and survives restarts (offline commits are pushed
on the next connect). The token defaults to the web example's `insecure-token-change-me`.

### Together with the web app

The web example lives in core. Run it from a core checkout:

```bash
# terminal 1 (core checkout): web app + its sync worker, port 60001
cd examples/web-todomvc-sync-cf
pnpm dev

# browser: http://localhost:60001/?storeId=shared-demo

# terminal 2 (contrib): Rust CLI on the same store; the sync endpoint is <origin>/sync
cd rust/examples
cargo run --bin todo -- --url ws://localhost:60001/sync --store shared-demo --data ./data
```

Todos added in either place show up in the other. Without `?storeId=` the web app generates a random
id and puts it in the URL; pass that id to `--store`.
