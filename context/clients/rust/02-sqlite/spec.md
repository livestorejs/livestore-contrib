# Rust Client SQLite — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Build

`crates/livestore-sqlite-sys` is published to the workspace as `libsqlite3-sys`
0.35.0 (`links = "sqlite3"`) and replaces the crates.io crate through
`[patch.crates-io]`; rusqlite runs without `bundled`.

- `sqlite/` holds `sqlite3.{c,h}` and `sqlite3ext.h`, produced by
  `rust/scripts/vendor-sqlite.sh` the way wa-sqlite does it: the GitHub tarball of
  `sqliteCommit` from core's `packages/@livestore/wa-sqlite/flake.nix`, then
  `configure --enable-all && make sqlite3.c`, plus wa-sqlite's `alt1` source-id
  marker. The sources stay vendored for now (LSC.CLIENT.RUST-DQ1).
- `build.rs` compiles it with wa-sqlite's `WASQLITE_DEFINES` and
  `WASQLITE_EXTRA_DEFINES`, and core's `wa-sqlite/src/extension-functions.c`
  (read from `repos/livestore`). `src/livestore.c` calls `sqlite3_initialize()`
  and registers the extension functions on every connection, as wa-sqlite's
  `main()` does. Bindings come from bindgen with upstream's options.

## Native Deviations

- `SQLITE_THREADSAFE=2` instead of `0`: rusqlite refuses single-threaded builds,
  and connections move between tokio worker threads. `MUTEX_OMIT` becomes
  `MUTEX_PTHREADS` as a result.
- `SQLITE_MAX_WORKER_THREADS=0` and `SQLITE_MAX_MMAP_SIZE=0` are pinned to the
  values wasm gets implicitly.
- Not compared: `COMPILER=`, `busy_timeout` (rusqlite sets 5 s), `cache_spill`
  (depends on pointer width).

## Bumping With wa-sqlite

1. After wa-sqlite's `flake.nix` or defines change: `rust/scripts/vendor-sqlite.sh`,
   and mirror define changes in `build.rs`.
2. `rust/scripts/check-sqlite-build.sh --refresh` must print `OK`.
3. If rusqlite moves to a new `libsqlite3-sys`, bump the crate version and recopy
   upstream `src/lib.rs`/`src/error.rs` and the bindgen options.

## Persistence

`livestore-sqlite` holds the eventlog and state databases (`LeaderDb` =
`LeaderPersistence`): `persist_local`, `persist_upstream`, rollback in reverse
journal order, and `rebuild`. `LocalLeader` is a sync-less helper for fixtures.
