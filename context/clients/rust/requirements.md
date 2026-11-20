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
  client can observe (eventlog rows, state rows and DDL, schema hashes, wire
  frames, SQLite behavior) equals what the TypeScript implementation produces for
  the same input. Equality is checked against fixtures dumped from core, not
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

- **LSC.CLIENT.RUST-DQ1 Vendored SQLite.** The SQLite amalgamation (~10 MB) is
  vendored in `rust/crates/livestore-sqlite-sys/sqlite/` so the build matches
  wa-sqlite exactly. Keep it vendored, fetch it at build time from the pinned
  wa-sqlite commit, or publish it as a separate crate?
- **LSC.CLIENT.RUST-DQ2 Parity baseline vs megarepo pin.** Parity was measured at
  core `06b50576509984475cca71bea8ea3f243c7650d1`, newer than the megarepo pin.
  Some tests read core snapshots and the core sync worker at test time, so they
  fail at the older pin. Bump the pin, or vendor those inputs into `rust/`?
