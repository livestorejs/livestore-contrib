# Rust Client Schema — Requirements

Role: the schema DSL and the pure (IO-free) event model of the Rust client.

## Context

Realizes core [`01-event-model/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/01-event-model) (`LS.SYS.EVT-*`) and
[`02-state/01-sqlite/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/02-state/01-sqlite) (`LS.SYS.STATE.SQLITE-*`) in
`rust/crates/livestore-schema` and `rust/crates/livestore-core`. Parent:
[../requirements.md](../requirements.md).

## Requirements

- **LSC.CLIENT.RUST.SCHEMA-R01 Same sequence numbers and events:** Composite
  sequence numbers, their notation, and event equality behave as in TypeScript,
  checked by the ported `EventSequenceNumber` and `LiveStoreEvent` tests.
  `refines: LS.SYS.EVT-R05, LS.SYS.EVT-R06, LS.SYS.EVT-R10`
- **LSC.CLIENT.RUST.SCHEMA-R02 Same DDL and hashes:** Tables, indexes, client
  documents, and system tables generate byte-identical DDL; table fingerprints and
  event schema hashes equal the TypeScript values, checked against fixtures from
  `rust/scripts/gen-schema-hash-fixtures.ts`.
  `refines: LS.SYS.STATE.SQLITE-R01, LS.SYS.STATE.SQLITE-R03, LS.SYS.STATE.SQLITE-R08`
- **LSC.CLIENT.RUST.SCHEMA-R03 Materializers return statements:** Materializers
  return SQL statements (like TS query builders) instead of running them, so the
  crate has no IO and `02-sqlite` executes them.
  `refines: LS.SYS.STATE-R02, LS.SYS.STATE.SQLITE-R02`
