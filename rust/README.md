# LiveStore Rust client

A native Rust LiveStore client. It talks to the Cloudflare sync backend (`@livestore/sync-cf`) over
WebSocket and keeps a local SQLite eventlog and state database that are byte-compatible with the
TypeScript leader. It ships the TodoMVC schema of core's `examples/web-todomvc-sync-cf`, so the Rust CLI
and the web app can share a store.

Intent (what it realizes, deviations, open questions): [`context/clients/rust/`](../context/clients/rust/spec.md).
Porting references: [`contributor-docs/rust/`](../contributor-docs/rust).

| Crate | What it is |
|---|---|
| `crates/livestore-core` | Sequence numbers, events, port of `sync/syncstate.ts` (`merge`) |
| `crates/livestore-schema` | Schema DSL: tables + DDL (byte-identical to TS), client documents, typed events, materializers, query builder |
| `crates/livestore-sqlite` | Leader persistence: materialize + journal, rollback/rebase, boot from disk |
| `crates/livestore-sqlite-sys` | The SQLite library, built from vendored sources to match wa-sqlite (replaces `libsqlite3-sys`) |
| `crates/livestore-sync` | `SyncBackend` trait, `LeaderSyncProcessor` actor, `Leader` builder; `testing` feature: `MockSyncBackend`, `EventFactory` |
| `crates/livestore-sync-cf` | sync-cf WebSocket/HTTP transport and its `SyncBackend` (`make_ws_sync`) |
| `crates/livestore` | Store: client session, commit, queries, reactivity |
| `crates/livestore-todomvc` | TodoMVC schema on the DSL |
| `crates/todo-tui` | Terminal TodoMVC app (`todo` binary) |

## Setup

Run everything from the contrib root inside `devenv shell`. It pins the Rust toolchain and provides
libclang (bindgen) and libiconv (macOS linking). The build reads files from the megarepo-pinned core
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
devenv tasks run rust:test                  # unit, fixture, mock- and fake-backend tests; live tests skip
devenv tasks run rust:test-live             # starts wrangler on a free port, runs the live tests, stops it
rust/scripts/test-live.sh --test e2e_ts     # only the Rust <-> TypeScript test
```

The live tests run against the sync worker of the pinned core
(`repos/livestore/tests/sync-provider/src/providers/cloudflare`). `test-live.sh` stages that worker and
the TodoMVC schema in a temp dir with links to the installed core packages, because those core
directories are not contrib workspace members.

`check:rust` is separate from `check:all`; CI runs it in `.github/workflows/rust.yml` on changes under
`rust/`, the devenv files, or the megarepo pin.

## Parity with the TypeScript tests

`parity/parity.md` maps every in-scope core Vitest test to its Rust port (or `n/a: <reason>`). It is
generated; edit `parity/status/*.tsv` and regenerate:

```bash
python3 rust/scripts/gen-parity.py                                   # rebuild from the cached list
python3 rust/scripts/gen-parity.py --core <core checkout> --refresh  # re-collect with that core's vitest
```

`--refresh` needs a core checkout with its own `pnpm install`: `repos/livestore` only has the packages
contrib installs, so core's root Vitest config does not load there. The committed list is for core
`06b50576509984475cca71bea8ea3f243c7650d1` (746 tests, 0 todo), which is newer than the megarepo pin.

## Fixtures

Fixtures come from the real TypeScript implementation of the pinned core:

```bash
bun rust/scripts/gen-syncstate-fixtures.ts       # fixtures/syncstate
bun rust/scripts/gen-leader-fixtures.ts          # fixtures/leader
bun rust/scripts/gen-schema-hash-fixtures.ts     # crates/livestore-schema/tests/fixtures
rust/scripts/check-sqlite-build.sh [--refresh]   # compares the native SQLite build with wa-sqlite
rust/scripts/vendor-sqlite.sh                    # re-vendors SQLite from wa-sqlite's flake.nix pin
```

`fixtures/wire/` holds real WebSocket captures; see
[`sync-cf-wire-protocol.md`](../contributor-docs/rust/sync-cf-wire-protocol.md).

## CLI

```bash
cd rust
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
cd rust
cargo run --bin todo -- --url ws://localhost:60001/sync --store shared-demo --data ./data
```

Todos added in either place show up in the other. Without `?storeId=` the web app generates a random
id and puts it in the URL; pass that id to `--store`.
