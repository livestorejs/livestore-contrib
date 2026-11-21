# Rust Client — Spec

Specifies the composition of the Rust client (`rust/`). Builds on
[requirements.md](./requirements.md); part mechanics live in the child specs.

## Status

Draft.

**Maturity: experimental**

## Scope

| Child | Owns | Crates |
| --- | --- | --- |
| [`01-schema`](./01-schema/spec.md) | schema DSL, DDL, client documents, events, materializers, query builder, schema hashes | `livestore-schema`, `livestore-core` |
| [`02-sqlite`](./02-sqlite/spec.md) | SQLite setup and leader persistence (eventlog, state, rollback, rebuild) | `livestore-sqlite` |
| [`03-leader`](./03-leader/spec.md) | leader sync processor, syncstate merge, backend contract | `livestore-sync`, `livestore-core` |

`livestore-todomvc` (example schema) consumes the stack and owns no contract.

Dependency direction:

```text
livestore-core <- livestore-schema <- livestore-sqlite <- livestore-sync <- livestore-sync-cf
                                                                      ^
                                                                      +--- livestore (store)
```

## Mapping From Effect

Each Effect concept maps onto one Rust mechanism so ported tests stay readable
next to their TypeScript originals: services and layers become trait objects
handed to a builder, tagged errors become `thiserror` types whose `tag()` returns
the TS `_tag`, scopes and fibers become cancellation tokens and tokio tasks,
`SubscriptionRef` becomes `tokio::sync::watch`, `TestClock` becomes paused tokio
time. The full table and the test-control mapping are in
[`contributor-docs/rust/effect-to-rust.md`](../../../contributor-docs/rust/effect-to-rust.md).

## Deviations

| Deviation | Core contract | Where |
| --- | --- | --- |
| Single session, constant leadership | LS.SYS.RT-R04 | [.delta/DELTA-001](./.delta/DELTA-001-single-session.md) |
| `SQLITE_THREADSAFE=2` (wa-sqlite: `0`) | LS.SYS.RT-R09 | [02-sqlite](./02-sqlite/spec.md#native-deviations) |
| No devtools surface | LS-R13 | not realized |

Not mirrored yet: `materializerHashes` on pull items, boot-status queue details,
`stateRebuildBatchSize`, and observers that need every intermediate
`syncState` value (`watch` coalesces; no ported test needs more).

## Verification

- `devenv tasks run check:rust` runs check, clippy, and the unit and fixture
  suites. CI: `.github/workflows/rust.yml`, only on changes to `rust/`, devenv
  files, or the megarepo pin.
