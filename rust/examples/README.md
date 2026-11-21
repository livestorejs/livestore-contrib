# Rust client examples

Apps built on the Rust client. This folder is a separate Cargo workspace with its own
`Cargo.lock`, so the examples' UI dependencies never enter the client's build. The examples
use the client crates through path dependencies (`../crates/*`).

| Example | UI | Shows |
|---|---|---|
| `todo-tui` | ratatui (terminal) | An app that already runs tokio |

Checks: `devenv tasks run rust:examples` (format, clippy, build).

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
