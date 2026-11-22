# Rust Client Store — Requirements

Role: the client session and store the application talks to.

## Context

Realizes core [`05-store/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/05-store) (`LS.SYS.STORE-*`, reactivity
`LS.SYS.STORE.RX-*`) and the session half of [`04-runtime/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime) in
`rust/crates/livestore`. Parent: [../requirements.md](../requirements.md).

## Requirements

- **LSC.CLIENT.RUST.STORE-R01 Same store surface:** `Store` provides commit,
  synchronous queries, subscriptions, events, sync status, and shutdown, and a
  `StoreRegistry` keyed like the TS registry.
  `refines: LS.SYS.STORE-R01, LS.SYS.STORE-R02, LS.SYS.STORE-R04, LS.SYS.STORE-R07, LS.SYS.STORE-R10`
- **LSC.CLIENT.RUST.STORE-R02 Same reactivity:** The reactive graph (refs,
  thunks, effects) and live queries dedupe and cut off propagation like
  `reactive.ts`, checked by its ported tests.
  `refines: LS.SYS.STORE.RX-R01, LS.SYS.STORE.RX-R03, LS.SYS.STORE.RX-R05`
- **LSC.CLIENT.RUST.STORE-R03 Same session sync:** The session sync processor
  numbers pending events after the leader head and rebases them on pull, as
  `ClientSessionSyncProcessor` does. `refines: LS.SYS.SYNC.SS-R01, LS.SYS.SYNC.SS-R04`
