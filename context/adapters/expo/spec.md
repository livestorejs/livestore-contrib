# Expo Adapter — Spec

Specifies the Expo adapter (`packages/@livestore/adapter-expo`) at the
realization-contract level. Builds on [requirements.md](./requirements.md); the
mechanism-agnostic contract is core
[`04-runtime/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/04-runtime/spec.md).
Citations are `src/…:line` within the package.

## Status

Draft.

## Entry & Preconditions

One factory, `makePersistedAdapter`, exported from `.`
(`src/index.ts:118`); it returns an `Adapter` that yields a `ClientSession`.
There is no worker variant and no `storage`-mode union — persistence is always
file-backed on the device.

Boot first asserts the React Native New Architecture (Fabric): `IS_NEW_ARCH` is
feature-detected from `nativeFabricUIManager` / `__turboModuleProxy`
(`src/index.ts:77`), and if absent the adapter returns an `UnknownError`
instructing the user to enable Fabric (`src/index.ts:122`). A `polyfill.ts` is
imported first (`src/index.ts:1`) to supply `Array.prototype.toSorted` on Hermes
(`src/polyfill.ts:7`).

Options (`MakeDbOptions`, `src/index.ts:46`): `storage.directory` (default
`SQLite.defaultDatabaseDirectory`), `storage.subDirectory`, `sync`, `clientId`
(default device id), `sessionId` (default `'static'`, `src/index.ts:137`),
`resetPersistence` (default false).

## Persistence

`expo-sqlite`'s native SQLite backs every database (`src/make-sqlite-db.ts:12`) —
there is no WASM SQLite build and no native `better-sqlite3` binding; this is a
deviation from core LS.SYS.RT-R09 (see
[.delta/DELTA-002](./.delta/DELTA-002-native-sqlite-substrate.md)). The
`makeSqliteDb` factory (`src/make-sqlite-db.ts:33`) opens two input shapes:

- **`file`** — `SQLite.openDatabaseSync(databaseName, {}, directory)`
  (`src/make-sqlite-db.ts:51`). Leader state and eventlog databases are files
  (`src/index.ts:251`, `:255`) under a resolved directory
  `directoryBasePath/subDirectory/storeId` (`src/index.ts:351`, `:355`): the
  state db is `livestore-{getStateDbBaseName(schema)}@{formatVersion}.db`, where
  the core helper keys it by the schema hash (`src/index.ts:357`), and the
  eventlog db is `livestore-eventlog@{formatVersion}.db` (`src/index.ts:358`).
- **`in-memory`** — `SQLite.openDatabaseSync(':memory:', { useNewConnection: true })`
  (`src/make-sqlite-db.ts:37`).

The **client-session** database is always in-memory (`src/index.ts:180`) and
hydrated by importing the leader's exported snapshot
(`src/index.ts:183`; the snapshot is `db.export()`, `src/index.ts:339`). Import
deserializes the bytes into a temp db and `backupDatabaseSync` into the target
(`src/make-sqlite-db.ts:157`); importing from an existing db handle throws
("not yet supported in expo", `src/make-sqlite-db.ts:153`) — see
LSC.ADAPT.EXPO-DQ3. Changesets/sessions use `expo-sqlite`'s native session API
(`src/make-sqlite-db.ts:167`).

`resetPersistence` broadcasts an `adapter-reset` shutdown first
(`src/index.ts:148`) then `SQLite.deleteDatabaseSync` for both the state and
eventlog files (`src/index.ts:385`, `:386`), retried with exponential backoff
(`src/index.ts:394`).

## Leadership

Expo does no leader election. The lock status is a constant `has-lock`
`SubscriptionRef` (`src/index.ts:143`) and the session is created with
`isLeader: true` (`src/index.ts:189`), realizing the single-leader invariant
(core LS.SYS.RT-R01) by construction. There is no `navigator.locks` and no
lockfile; the only cross-context channel is a same-thread shutdown channel
(`WebChannel.sameThreadChannel`, `livestore.shutdown.{storeId}`,
`src/shutdown-channel.ts:6`, `:7`) — a degenerate single-context realization of
the shutdown-cause contract (core LS.SYS.RT-R06). Handover (core LS.SYS.RT-R04)
is **not** realized (`src/shutdown-channel.ts:4` carries a multi-threading TODO);
see [.delta/DELTA-001](./.delta/DELTA-001-no-handover.md).

The adapter listens on the shutdown channel and routes an
`IntentionalShutdownCause` to `Exit.succeed` and any other cause to `Exit.fail`
(`src/index.ts:153`).

## Session Boot

Boot offers `{ stage: 'loading' }` to the session boot-status queue on start
(`src/index.ts:141`). The leader thread is built by `makeLeaderThread`
(`src/index.ts:216`) over `makeLeaderThreadLayer` from
`@livestore/common/leader-thread` (`src/index.ts:270`). The adapter supplies
core's `StateHead` service from the same state database (`src/index.ts:283`); a
forked fiber drains the
leader-thread boot-status queue into the session's boot-status queue
(`src/index.ts:297`), interrupted when the session queue shuts down
(`src/index.ts:304`). Migrations run inside the leader layer and their
`migrationsReport` is surfaced on the proxy's initial state (`src/index.ts:329`),
alongside a `leaderHead` read from the eventlog db (`src/index.ts:310`, `:328`)
and a hardcoded `storageMode: 'persisted'` (`src/index.ts:330`) — see
LSC.ADAPT.EXPO-DQ2.

> **Note.** `src/index.ts:117` carries a TODO to refactor this local leader-thread
> wiring onto the shared `@livestore/common/leader-thread` code; the adapter
> currently open-codes part of the boot/proxy assembly.

## Leader-Thread Proxy

The session is `makeClientSession(… webmeshMode: 'proxy', isLeader: true …)`
(`src/index.ts:185`, `:193`, `:189`); `registerBeforeUnload` is effectively a
no-op (a commented-out `RN.AppState` listener; `src/index.ts:203`). Because the
leader is in-process, the `ClientSessionLeaderThreadProxy`
(`src/index.ts:312`) holds direct references — no serialization boundary:

- `events.pull` / `events.push` call `syncProcessor.pull` / `.push`
  (`src/index.ts:314`, `:315`); `push` wraps each item as
  `LiveStoreEvent.Client.EncodedWithMeta` with `waitForProcessing: true`
  (`src/index.ts:317`, `:318`).
- `events.stream` calls `streamEventsWithSyncState` over the eventlog db and the
  sync processor's sync state (`src/index.ts:320`).
- `export` / `getEventlogData` return `db.export()` / `dbEventlog.export()`
  synchronously (`src/index.ts:332`, `:333`) — unlike the Node worker path,
  `getEventlogData` **is** implemented here.
- `sendDevtoolsMessage` offers onto the leader's `extraIncomingMessagesQueue`
  (`src/index.ts:335`); `syncState` and `networkStatus` are passed through
  (`src/index.ts:334`, `:336`).

## Devtools

Enabled only when `devtoolsEnabled` is true (`src/index.ts:164`, `:195`,
`:414`). Unlike Node, Expo hosts **no** devtools server; it connects _outward_
over a Webmesh WebSocket to an external server. The target URL is resolved by
`getDevtoolsUrl` (`src/index.ts:460`): it reads
`EXPO_PUBLIC_LIVESTORE_DEVTOOLS_URL` (default `ws://0.0.0.0:4242`) for the port
and rewrites the host to the React Native dev server's host
(`react-native/Libraries/Core/Devtools/getDevServer`, `src/index.ts:464`), so a
physical device or emulator reaches the developer's machine; when devtools are
disabled the URL falls back to `ws://127.0.0.1:4242` (`src/index.ts:164`).

Both the leader and the session connect a Webmesh node to that URL: the leader
node is `Devtools.makeNodeName.client.leader` connected inside the devtools boot
effect (`src/index.ts:428`, `:430`), and the session connects its webmesh node
via `connectWebmeshNode` with a 500ms open timeout (`src/index.ts:196`,
`:199`). The leader's `persistenceInfo` (state + eventlog) is reported to
devtools (`src/index.ts:423`). The protocol and surfaces are owned by core
[`07-devtools/`](https://github.com/livestorejs/livestore/blob/main/context/02-system/07-devtools/spec.md).

## Client & Session Identity

`clientId` defaults to the device id (`getDeviceId`, `src/index.ts:441`):
`ExpoApplication.getAndroidId()` on Android (`src/index.ts:443`) and
`getIosIdForVendorAsync()` on iOS (`src/index.ts:445`); any other platform is a
`shouldNeverHappen` (`src/index.ts:452`). `sessionId` defaults to `'static'`
(`src/index.ts:137`).
