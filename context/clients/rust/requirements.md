# Rust Client — Requirements

Role: a native Rust LiveStore client (schema, leader, sync-cf provider client,
store) that shares stores with TypeScript clients through the same sync backend.

## Context

Refines the core platform-agnostic and determinism requirements (LS-R05, LS-R07)
and realizes the leader/session runtime contract
([`02-system/04-runtime/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime),
`LS.SYS.RT-*`) in a second language. Code: [`rust/`](../../../rust/README.md).
Children own the parts; this node owns the cross-cutting contract and the
deviations.

## Requirements

- **LSC.CLIENT.RUST-R01 Byte-compatible with TypeScript:** Every artifact another
  client can observe (eventlog rows, state rows and DDL, wire frames, SQLite
  behavior) equals what the TypeScript implementation produces for the same
  input. Schema hashes are excluded: they never leave the device, so each client
  only has to agree with itself. Equality is checked against fixtures dumped from core, not
  asserted by review. `refines: LS-R05, LS-R07`
- **LSC.CLIENT.RUST-R02 Test-for-test parity:** Each in-scope core Vitest test has
  a named Rust port or a stated `n/a` reason; parity is claimed only when none is
  `todo`. The mapping is a generated artifact (`rust/parity/`). `refines: LS-R05`
- **LSC.CLIENT.RUST-R03 Single session, in-process leader:** One client session
  per store, its leader in the same process; leadership is constant. Multi-session
  handover (core LS.SYS.RT-R04) is not realized
  ([.delta/DELTA-001](./.delta/DELTA-001-single-session.md)).
  `refines: LS.SYS.RT-R01, LS.SYS.RT-R05`
- **LSC.CLIENT.RUST-R04 One sync provider:** Only the sync-cf provider client is
  realized (WebSocket, plus HTTP). DO-RPC, devtools, and the other providers are
  out of scope until a consumer needs them. `refines: LS-R08`
- **LSC.CLIENT.RUST-R05 Parity is pinned to a core commit:** The parity claim
  names the core commit it was measured at. A core pin change re-runs the parity
  generator and the suite, and reports drift before Rust tests change.
  `refines: LS-R05`

## Open Design Questions

None open.

(LSC.CLIENT.RUST-DQ1 Vendored SQLite was resolved 2026-11-20: the client uses
rusqlite's bundled SQLite with runtime settings matching wa-sqlite, and
`rust:sqlite-check` fails CI on any behavior difference outside a known list; see
[02-sqlite](./02-sqlite/spec.md). LSC.CLIENT.RUST-DQ2 Parity
baseline vs megarepo pin was resolved 2026-11-20: the megarepo pin moved to the
parity baseline.)
