# Rust Client Leader — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Surface

`Leader::builder(schema).client_id(..).sync(SyncOptions { backend, live_pull, on_sync_error, on_backend_id_mismatch, initial_sync, backoff }).params(..).testing(..).random(..).boot()`.
The handle exposes `push`, `pull_queue(cursor)` (the `upstream-advance` /
`upstream-rebase` payloads for sessions), `sync_state()`, `is_connected()`,
`shutdown_cause()`, `boot_status()` (all `watch` receivers), `query`, and
`stream_events` (`streamEventsWithSyncState`).

`push` validates each batch against the admitted head (`LeaderAheadError`,
`NonContiguousBatchError`, `StaleRebaseGenerationError`). Defects in a provider
future are caught and reported as `UnknownError` with `defect: true`.

## Testing Surface

Feature `testing` provides `MockSyncBackend` (`connect`, `disconnect`, `advance`,
`fail_next_pushes`, `fail_next_pulls`, `take_pushed`), `BackendOverride` (TS
`mockBackendOverride`), and `EventFactory`. `Testing { .. }` mirrors
`testing.syncProcessor.{delays,hooks}`; hooks run inside the mailbox turn as in
TS. The full control mapping is in
[`effect-to-rust.md`](../../../../contributor-docs/rust/effect-to-rust.md).
