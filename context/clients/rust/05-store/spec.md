# Rust Client Store — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Topology

`InMemoryAdapter` (`adapter.rs`, TS `makeInMemoryAdapter`) boots a `Leader` in the
same process, seeds the session database from the leader's state snapshot, and
wires the leader proxy (`session.rs`). There is exactly one session per store
(LSC.CLIENT.RUST-R03).

## Process and Threads

A Rust app runs LiveStore inside its own process. Windows, views and stores in
that process share memory, so the client needs no workers, no tab election and
no transport between sessions and the leader.

```text
App process (needs a tokio runtime)
├── caller thread (UI or any thread)
│     commit:  write the event to the session DB, run its materializer,
│              refresh the affected queries, run their subscribe callbacks
│     query:   read the session DB (blocking, short)
└── tokio tasks
      session: push commits to the leader, apply pulled events and rebases,
               refresh queries, run subscribe callbacks
      leader:  eventlog + state on disk, merge, rebase, sync backend I/O
```

- **Threads.** `commit` and `query` are synchronous and run on the caller's
  thread. Only local SQLite work runs there; network I/O and waiting run on
  tokio tasks. A `subscribe` callback runs on the thread that changed the data:
  the caller's thread after a commit, a tokio worker after a pull. Apps whose
  UI thread must not block forward the result to it, for example with GPUI's
  `notify`, rune's `AppHandle::update`, or a channel into a TUI event loop.
- **Runtime.** `create_store` must run inside a tokio runtime (1.47 or newer),
  and the store keeps that runtime for its tasks. After that, any thread may
  commit, query and subscribe. An app without tokio (GPUI, rune) starts one
  runtime on a background thread and creates its stores there.
- **One store.** One `Store` = one session, one leader, one data folder, one
  sync connection.
- **Several stores.** Each store is independent: its own leader, folder and
  sync connection. A window may use several stores.
- **Several windows.** Windows share the same `Store` handle (it is `Clone`).
  `StoreRegistry` returns the cached store when code opens the same `storeId`
  again. Two stores on one data folder fail with `Error::Locked` from the
  leader's folder lock.
- **Several processes.** Not supported on one data folder, by design. Another
  process is a separate client with its own folder and syncs through the
  backend.

## Observability

The store emits the TS span names and attributes (`createStore`,
`LiveStore:commit`, `LiveStore.subscribe`, `db:<sql>`, `sql-in-memory-select`,
`client-session-sync-processor:*`) through `tracing`. Tests compare span trees
with core's Vitest snapshots, read from `repos/livestore` at test time, so a core
pin change can fail them without a Rust change (LSC.CLIENT.RUST-R05).
