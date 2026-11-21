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
| `crates/livestore-macros` | `#[derive(Event)]`: an event defined once, from its args struct |
| `crates/livestore-sqlite` | Leader persistence: materialize + journal, rollback/rebase, boot from disk |
| `crates/livestore-sync` | `SyncBackend` trait, `LeaderSyncProcessor` actor, `Leader` builder; `testing` feature: `MockSyncBackend`, `EventFactory` |
| `crates/livestore-sync-cf` | sync-cf WebSocket/HTTP transport and its `SyncBackend` (`make_ws_sync`) |
| `crates/livestore` | Store: client session, commit, queries, reactivity |
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
`06b50576509984475cca71bea8ea3f243c7650d1` (746 tests, 0 todo), the same commit as the megarepo pin.

## Fixtures

Fixtures come from the real TypeScript implementation of the pinned core:

```bash
bun rust/scripts/gen-syncstate-fixtures.ts       # fixtures/syncstate
bun rust/scripts/gen-leader-fixtures.ts          # fixtures/leader
rust/scripts/check-sqlite-build.sh               # compares SQLite behavior with wa-sqlite (known differences allow-listed)
```

`fixtures/wire/` holds real WebSocket captures; see
[`sync-cf-wire-protocol.md`](../contributor-docs/rust/sync-cf-wire-protocol.md).
