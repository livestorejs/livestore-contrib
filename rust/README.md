# LiveStore Rust client

A native Rust LiveStore client. It talks to the Cloudflare sync backend (`@livestore/sync-cf`) over
WebSocket and keeps a local SQLite eventlog and state database that are byte-compatible with the
TypeScript leader. It ships the TodoMVC schema of core's `examples/web-todomvc-sync-cf`, so the Rust CLI
and the web app can share a store.

Intent (what it realizes, deviations, open questions): [`context/clients/rust/`](../context/clients/rust/spec.md).
Porting references: [`contributor-docs/rust/`](../contributor-docs/rust).

| Crate | What it is |
|---|---|
| `crates/livestore-core` | Sequence numbers and events |
| `crates/livestore-schema` | Schema DSL: tables + DDL (byte-identical to TS), client documents, typed events, materializers, query builder |
| `crates/livestore-macros` | `#[derive(Event)]`: an event defined once, from its args struct |
| `crates/livestore-todomvc` | TodoMVC schema on the DSL |

## Setup

Run everything from the contrib root inside `devenv shell`. It pins the Rust toolchain and provides
libiconv (macOS linking). Some tests read files from the megarepo-pinned core
(`repos/livestore`), so bootstrap it first:

```bash
devenv tasks run mr:bootstrap --mode before     # materializes repos/livestore
devenv tasks run pnpm:install --mode before     # only for live tests and the TS scripts
```

## Tests

```bash
devenv tasks run check:rust --mode before   # all of the below
devenv tasks run rust:check                 # cargo check
devenv tasks run rust:clippy                # clippy, warnings are errors
devenv tasks run rust:doc                   # cargo doc, warnings are errors
devenv tasks run rust:test                  # unit, fixture, mock- and fake-backend tests; live tests skip
```

`check:rust` is separate from `check:all`; CI runs it in `.github/workflows/rust.yml` on changes under
`rust/`, the devenv files, or the megarepo pin.
