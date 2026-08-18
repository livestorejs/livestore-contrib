# Node Adapter — Spec

Specifies the Node adapter (`packages/@livestore/adapter-node`) at the
realization-contract level. Builds on [requirements.md](./requirements.md); the
mechanism-agnostic contract is core
[`04-runtime/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/04-runtime/spec.md).
Citations are `src/…:line` within the package.

## Status

Draft.

## Entry & Variants

Two factories, exported from `.` (`src/index.ts:1`); persistence is a `storage`
option on either, not a separate factory. Both return the same `ClientSession`.

| Variant | Factory | Leader location | Sync config |
| --- | --- | --- | --- |
| Single-threaded | `makeAdapter` (`src/client-session/adapter.ts:129`) | in-process (same thread as the app; `src/client-session/adapter.ts:354`) | `sync` option, threaded into the leader layer (`src/client-session/adapter.ts:274`) |
| Worker | `makeWorkerAdapter` (`src/client-session/adapter.ts:168`) | one `node:worker_threads` worker, serialized pool of size 1 (`src/client-session/adapter.ts:462`, `:473`) | configured inside the worker entry file passed to `makeWorker` (`src/make-leader-worker.ts:25`) |

Options (`NodeAdapterOptions`, `src/client-session/adapter.ts:49`): `storage`
(required), `clientId` (default OS `hostname()`, `:187`), `sessionId` (default
`'static'`, `:189`), `resetPersistence` (default false), `devtools`. The worker
entry (`./worker`) exports `makeWorker` / `makeWorkerEffect` / `getWorkerArgs`
(`src/make-leader-worker.ts:37`); worker startup passes a JSON `argv` payload
(`storeId/clientId/sessionId/extraArgs`) and Node `execArgv`
(`--enable-source-maps`, `--inspect` under `DEBUG_WORKER`)
(`src/client-session/adapter.ts:463`).

## Persistence

WASM SQLite (`@livestore/sqlite-wasm/node`) backs every database — no
`better-sqlite3` / `node:sqlite` native binding is used
(`src/client-session/adapter.ts:21`). The `storage` union
(`src/worker-schema.ts:46`) is:

- **`fs`** — leader state and eventlog databases are files under
  `baseDirectory/storeId` (default `baseDirectory` = cwd)
  (`src/leader-thread-shared.ts:86`): `state{schemaHashSuffix}@{formatVersion}.db`
  (suffix is the schema hash;
  `src/leader-thread-shared.ts:69`, `:88`, `:129`) and
  `eventlog@{formatVersion}.db` (`:88`). Opened with `foreignKeys: true`; WAL is
  not yet enabled (`// TODO enable WAL for nodejs`, `:89`) — see
  LSC.ADAPT.NODE-DQ1.
- **`in-memory`** — leader databases are in-memory; an optional `importSnapshot`
  is imported then migrated (single-threaded only)
  (`src/leader-thread-shared.ts:79`, `:99`; `src/worker-schema.ts:25`).

Independently of `storage`, the **client-session** database is always in-memory
and hydrated from the leader's exported snapshot
(`src/client-session/adapter.ts:244`, `:293`) — the core in-memory-session-db
decision. `resetPersistence` recursively removes `baseDirectory/storeId` for
`fs` (broadcasting an `adapter-reset` shutdown first) and is a no-op otherwise
(`src/client-session/adapter.ts:325`, `:225`).

## Leadership

Node does no leader election. The session is unconditionally leader
(`isLeader: true`, `src/client-session/adapter.ts:313`) and lock status is a
constant `has-lock` `SubscriptionRef` (`:246`, with a `// TODO … multi-session
support`). There is no `navigator.locks` and no lockfile; the only
cross-instance channel is a `BroadcastChannel` (`livestore.shutdown.{storeId}`,
`src/shutdown-channel.ts:9`) used for shutdown propagation, degrading to a noop
channel with a warning when unavailable (`src/webchannel.ts:15`). This realizes
the single-leader invariant (core LS.SYS.RT-R01) by construction and does **not**
realize handover (core LS.SYS.RT-R04): concurrent sessions on one `storeId` are
unsupported (LSC.ADAPT.NODE-R03).

## Session Boot

Boot offers `{ stage: 'loading' }` to the session boot-status queue on start
(`src/client-session/adapter.ts:210`). Migrations run inside the leader-thread
layer and their `migrationsReport` is surfaced on the proxy's initial state
(single-threaded `src/client-session/adapter.ts:416`; worker
`GetRecreateSnapshot` → `{ snapshot, migrationsReport }`,
`src/make-leader-worker.ts:130`, consumed `src/client-session/adapter.ts:532`).
The worker path streams boot status out of the worker
(`LeaderWorkerInnerBootStatusStream`, `:513`) and fetches the leader head /
recreate snapshot with a 10s timeout-or-die (`:530`).

## Leader-Thread Proxy

The session is `makeClientSession(… webmeshMode: 'proxy', isLeader: true …)`
(`src/client-session/adapter.ts:296`); `registerBeforeUnload` is a no-op (Node
has no reload; `:314`). The `ClientSessionLeaderThreadProxy` is implemented per
topology:

- **Single-threaded** (`:401`): methods call the in-process `syncProcessor` /
  `dbState` / `dbEventlog` directly — no serialization boundary.
- **Worker** (`:537`): each method is an RPC. Requests are `Schema.TaggedRequest`
  types unioned as `LeaderWorkerInnerRequest` (`src/worker-schema.ts:224`); large
  payloads use `Transferable.Uint8Array` (`:135`); transport errors are refined
  to defects (`src/client-session/adapter.ts:497`, `:509`). `getEventlogData` is
  not implemented in the worker path (`:563`).

Worker-side handlers map 1:1 to the request schema
(`src/make-leader-worker.ts:58`); the `Shutdown` handler is a no-op stub
(`:140`).

## Devtools

Enabled only when `devtools` is provided (`src/client-session/adapter.ts:249`,
default port 4242 / host localhost). The leader lazily starts a Node
`http.createServer` devtools server (`src/devtools/devtools-server.ts:38`,
`:146`) that serves the devtools UI via an optional Vite middleware
(`@livestore/devtools-vite` + `vite`, dynamically imported with dedicated
not-installed errors; `src/devtools/vite-dev-server.ts:59`) and the Devtools
protocol over a Webmesh WebSocket edge (`:72`). Leader and session each connect a
Webmesh node (`Devtools.makeNodeName.client.{leader,session}`) to the server
(`src/leader-thread-shared.ts:174`; `src/client-session/adapter.ts:300`). The
protocol and surfaces are owned by core
[`07-devtools/`](https://github.com/livestorejs/livestore/blob/main/context/02-system/07-devtools/spec.md).
