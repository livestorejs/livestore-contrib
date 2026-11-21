# Rust client: Effect → Rust mapping

Goal: every TS client test can be ported one-to-one. TS uses Effect for dependency injection, typed errors,
scopes and fibers. Each of those maps onto a plain Rust mechanism below.

## Effect concept → Rust mechanism

| Effect / TS | Rust | Where |
|---|---|---|
| `Context.Service` + `Layer` (DI) | Trait objects handed to a typed builder: `Leader::builder(schema).sync(SyncOptions { backend: Some(ctor), .. }).params(..).testing(..).random(..).boot()` | `livestore-sync/src/leader.rs` |
| `SyncBackend` service | `trait SyncBackend` (`connect/pull/push/ping/is_connected/metadata/supports`), built by a `SyncBackendConstructor` (`Fn(MakeBackendArgs) -> BoxFuture<Arc<dyn SyncBackend>>`) | `livestore-sync/src/backend.rs` |
| `KeyValueStore` given to the backend (backend id) | `trait BackendIdStore` in `MakeBackendArgs` | same |
| `{ ...backend, pull: ... }` spread (mock override) | `BackendOverride::new(inner).pull(..).push(..)` | same |
| Tagged errors (`Schema.TaggedError`) | `thiserror` structs/enums named like the TS tags; `.tag()` returns the TS `_tag` | `livestore-sync/src/errors.rs`, `livestore-sqlite/src/lib.rs` |
| Error channel unions (`IsOfflineError \| UnknownError \| ...`) | Per-method enums `ConnectError`, `PullError`, `PushError`, `PingError` | `errors.rs` |
| Defect (`Effect.die`) | A panic inside a provider future, caught with `catch_unwind`; reported as `UnknownError` with `defect: true` | `processor.rs` |
| Interrupt | `AbortHandle::abort` on the task; the session's leader push is interrupted through a `CancellationToken` and the cancel path awaits finalizers registered with `session::ensuring` (`Effect.ensuring`); a dropped reply channel = interrupted push (`LeaderPushError::Interrupted`) | `processor.rs` |
| `Scope` / `forkScoped` / finalizers | `tokio_util::sync::CancellationToken` owned by the leader (cancelled on last drop / `shutdown()`), `JoinSet` for background timers, abort-on-drop guards | `leader.rs`, `processor.rs` |
| `FiberHandle` (one push / one pull fiber) | `Option<AbortHandle>` replaced on restart | `processor.rs` |
| `Queue` mailbox | `tokio::sync::mpsc::unbounded_channel` consumed by one actor task | `processor.rs` |
| `Deferred` | `tokio::sync::oneshot` | push replies, page completions |
| `SubscriptionRef` / `Subscribable` | `tokio::sync::watch` (`borrow()` = get, `changed()`/`wait_for` = changes) | `sync_state()`, `is_connected()`, `shutdown_cause()`, `boot_status()` |
| `Stream` | `futures::Stream` (`BoxStream` for backend pulls, `unfold` for `stream_events`) | `backend.rs`, `stream_events.rs` |
| `ShutdownChannel` (`WebChannel`) | `watch::Receiver<Option<ShutdownCause>>` from `Leader::shutdown_cause()` | `leader.rs` |
| `TestClock` | `#[tokio::test(start_paused = true)]` / `tokio::time::pause()`; all timers use `tokio::time` | tests |
| `Random` service | `trait Random` (`StdRandom`, deterministic `FixedRandom`) | `options.rs` |
| `testing.syncProcessor.{delays,hooks}` | `Testing { local_push_processing, backend_pull_reconnect, local_push_admitted, upstream_batch_received, backend_pull_reconnect_wait }`; hooks are async closures awaited inside the mailbox turn, like TS | `options.rs` |
| `Effect.withSpan` | `tracing` spans with the TS span names (`@livestore/common:LeaderSyncProcessor:push`, `...:backend-pulling`, `@livestore/common:leader-thread:boot`, `...:materializeEvent`, `@livestore/common:streamEvents:segment`); the Store emits the TS store spans (`createStore`, `LiveStore:commit`, `LiveStore.subscribe`, `db:<sql>`/`js:<label>` via `otel.name`, `client-session-sync-processor:*`, `sql-in-memory-select`, ...) with TS attribute names | throughout; tests capture them in `crates/livestore/tests/common/otel.rs` |
| `makeSchema`, `State.SQLite.table`, `Events.synced`, `clientDocument`, materializers | `Schema::builder().table(..).client_document(..).event(&EventDef::<Args>::synced(name), \|args, ctx\| Ok(stmt))`; args are serde types; materializers return `SqlStatement`s like TS query builders | `livestore-schema` |

## Injecting a fake backend in a test

```rust
use livestore_sync::testing::{MockSyncBackend, MockSyncBackendOptions, EventFactory, ClientIdentity};
use livestore_sync::*;

let mock = MockSyncBackend::new(MockSyncBackendOptions::default());
let leader = Leader::builder(schema)
    .client_id("test")
    .sync(SyncOptions { backend: Some(mock.constructor()), live_pull: Some(true), ..Default::default() })
    .testing(Testing { upstream_batch_received: Some(hook(|events| async move { /* hold the page */ })), ..Default::default() })
    .random(Arc::new(FixedRandom))
    .boot().await?;

mock.connect();                                    // isConnected = true
leader.push(vec![EventFactory::new(ClientIdentity::new("test")).next_client("todoCreated", args)]).await?;
mock.take_pushed(1).await;                         // pushedEvents.pipe(Stream.take(1))
mock.advance(vec![remote_event]).await;            // another client pushed
mock.fail_next_pushes(1, Some(Arc::new(|_| ServerAheadError { .. }.into())));
leader.sync_state().wait_for(|s| s.upstream_head.global == 2).await;
leader.shutdown_cause().wait_for(Option::is_some).await;   // captureShutdown
```

To replace one method (TS `mockBackendOverride`), wrap the mock connection:
`constructor(move |_| async move { Ok(Arc::new(BackendOverride::new(mock.make_sync_backend().await).pull(..)) as _) })`.
See `rust/crates/livestore-sync/tests/leader_processor.rs` for 16 worked examples, each mirroring a TS test.

## TS test-fixture control mapping

| TS (`LeaderSyncProcessor.test.ts` / `fixture.ts`) | Rust |
|---|---|
| `makeMockSyncBackend({ nonLiveChunkSize, startConnected })` | `MockSyncBackend::new(MockSyncBackendOptions { .. })` |
| `mock.connect` / `mock.disconnect` | `mock.connect()` / `mock.disconnect()` |
| `mock.advance(...events)` | `mock.advance(vec![..]).await` |
| `mock.failNextPushes(n, err?)` / `failNextPulls(n, err?)` | `mock.fail_next_pushes(n, Some(Arc::new(\|batch\| err)))` / `fail_next_pulls` |
| `mock.pushedEvents.pipe(Stream.take(n))` | `mock.take_pushed(n).await` / `next_pushed()` |
| `mock.makeSyncBackend` | `mock.make_sync_backend().await`, `mock.constructor()` |
| `mockBackendOverride` | `BackendOverride` |
| `syncOptions.{livePull, onSyncError, onBackendIdMismatch, initialSyncOptions}` | `SyncOptions { live_pull, on_sync_error, on_backend_id_mismatch, initial_sync, backoff }` |
| `params.{localPushBatchSize, backendPushBatchSize}` | `Params { .. }` |
| `testing.syncProcessor.delays/hooks` | `Testing { .. }` |
| `captureShutdown` + `shutdownDeferred` | `leader.shutdown_cause()` |
| `leaderThreadCtx.syncProcessor.push` / `pushEncoded` | `leader.push(events)` |
| `syncProcessor.pullQueue({ cursor })` | `leader.pull_queue(cursor)` |
| `syncProcessor.syncState.get/changes` | `leader.sync_state()` (`borrow`, `wait_for`) |
| `StateSqliteDb` / `EventlogSqliteDb` selects | `leader.query(sql)`, `leader.db().lock().unwrap().{state_conn,eventlog_conn}()` |
| `getStateHead(dbState)` | `LeaderDb::state_head()` |
| `EventFactory.makeFactory(events)({ client, startSeq, initialParent })` | `EventFactory::starting_at(ClientIdentity::with_session(..), start, Sequence::At(n))`, `.next(name, args)`, `.advance_to`, `.set_parent`, `.current` |
| `streamEventsWithSyncState({ dbEventlog, syncState, options })` | `stream_events(db, watch_rx, EventQuery { .. })` (tests drive their own `watch::channel`) |
| `makeMaterializeEvent` / `recreateDb` / `LeaderPersistence.persistLocal/persistUpstream` | `livestore_sqlite::state::{materialize, rebuild}`, `LeaderDb::{persist_local, persist_upstream}` |
| `schema.unknownEventHandling` | `SchemaBuilder::unknown_event_handling(UnknownEventHandling::{Warn,Ignore,Fail,Callback})` |
