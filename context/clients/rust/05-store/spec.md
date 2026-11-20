# Rust Client Store — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Topology

`InMemoryAdapter` (`adapter.rs`, TS `makeInMemoryAdapter`) boots a `Leader` in the
same process, seeds the session database from the leader's state snapshot, and
wires the leader proxy (`session.rs`). There is exactly one session per store
(LSC.CLIENT.RUST-R03).

## Observability

The store emits the TS span names and attributes (`createStore`,
`LiveStore:commit`, `LiveStore.subscribe`, `db:<sql>`, `sql-in-memory-select`,
`client-session-sync-processor:*`) through `tracing`. Tests compare span trees
with core's Vitest snapshots, read from `repos/livestore` at test time, so a core
pin change can fail them without a Rust change (LSC.CLIENT.RUST-R05).
