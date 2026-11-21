# Rust Client SQLite — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Build

The client uses `rusqlite` (pinned in `rust/Cargo.toml`) with its `bundled`
SQLite plus the `session` and `serialize` features. The repo holds no SQLite
sources and needs no setup beyond a C compiler.

## Runtime Settings

`livestore_sqlite::configure_connection` runs on every connection the client
opens (`LeaderDb::boot_with`, `SqliteDbWrapper::new`) and turns off what the
bundled build enables but wa-sqlite does not:

- `SQLITE_DBCONFIG_DQS_DML` and `SQLITE_DBCONFIG_DQS_DDL` (wa-sqlite builds with
  `SQLITE_DQS=0`: double-quoted strings are identifiers only).
- `SQLITE_DBCONFIG_ENABLE_FKEY` (rusqlite builds with
  `SQLITE_DEFAULT_FOREIGN_KEYS=1`; wa-sqlite starts with foreign keys off).

## Known Differences

Behavior LiveStore relies on is the same; these differ and are allow-listed in
the drift check:

- SQLite version and source id follow rusqlite, not wa-sqlite's pin.
- wa-sqlite's `extension-functions.c` (math, string, and aggregate helpers such
  as `sqrt`, `padl`, `stdev`) is not available.
- `LIKE` matches blobs (wa-sqlite: `SQLITE_LIKE_DOESNT_MATCH_BLOBS`), and the
  expression depth limit is 1000 (wa-sqlite: unlimited); neither has a runtime
  switch.
- No `bytecode`/`tables_used` virtual tables; the client derives the tables a
  query uses from its plan.
- Extra features LiveStore does not use: FTS3/4/5, R*Tree, STAT4, dbstat,
  soundex, column metadata, and `load_extension` (compiled in but disabled).
- `SQLITE_THREADSAFE=1` instead of `0`: connections move between tokio threads.
- Build-only options with no effect on results (`OMIT_*`, `USE_ALLOCA`,
  `DEFAULT_MEMSTATUS`, mmap and worker-thread maxima, WAL synchronous default),
  plus `busy_timeout` (rusqlite sets 5 s) and `cache_spill` (pointer width).

## Drift Check

`rust:sqlite-check` (`rust/scripts/check-sqlite-build.sh`) dumps effective
pragmas, behavior probes (double-quoted strings in DML and DDL, LIKE on blobs,
JSON, optional modules), modules, functions, and compile options from the pinned
core wa-sqlite and from a configured Rust connection. It requires the session
and preupdate-hook options on both sides and fails on any difference outside
its allow-list.

## Persistence

`livestore-sqlite` holds the eventlog and state databases (`LeaderDb` =
`LeaderPersistence`): `persist_local`, `persist_upstream`, rollback in reverse
journal order, and `rebuild`. `LocalLeader` is a sync-less helper for fixtures.

## One Leader per Data Folder

`LeaderDb::open` takes an exclusive OS lock (`File::try_lock`) on
`<eventlog>.lock` and holds it while the databases are open. A second leader on
the same files, in the same or another process, fails with `Error::Locked`. The
OS releases the lock when the process exits, also on a crash. Processes never
share a data folder: a separate process uses its own folder and syncs through
the backend like any other client.
