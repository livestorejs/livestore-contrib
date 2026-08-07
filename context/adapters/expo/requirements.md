# Expo Adapter — Requirements

Role: the Expo / React Native realization of LiveStore's adapter/runtime
contract — a single in-process leader over device-filesystem `expo-sqlite`, for
iOS and Android apps.

## Context

Refines the core adapter/runtime contract
([`02-system/04-runtime/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime),
`LS.SYS.RT-*`) and the core determinism requirement (LS-R05). Package:
[`packages/@livestore/adapter-expo`](../../../packages/@livestore/adapter-expo).
The web adapter
([core `04-runtime/01-web/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime/01-web))
is the reference realization; the sibling contrib [Node adapter](../node/requirements.md)
is the closest relative. Expo has no worker threads, no leader election, and no
WASM SQLite build — it runs one JS thread, one session, one in-process leader,
over `expo-sqlite`'s native SQLite; those deviations are stated here, never
silent. Conformance status lives in the core adapter registry
([`04-runtime/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/04-runtime/realizations.md));
the shared adapter conformance suite is contracted but unbuilt (core
LS.SYS.VER.CONF-R03).

## Requirements

- **LSC.ADAPT.EXPO-R01 Single in-process realization:** The adapter exposes one
  factory (`makePersistedAdapter`); the leader runs in the app's own JS thread
  (no worker), and the single session is unconditionally that leader. There is
  no worker/topology choice as on Node — Expo is single-threaded today (the
  shutdown channel is a same-thread channel with a TODO to add multi-threading).
  `refines: LS.SYS.RT-R01, LS.SYS.RT-R05`
- **LSC.ADAPT.EXPO-R02 Native `expo-sqlite` file persistence:** Leader state and
  eventlog databases are files on the device filesystem via `expo-sqlite`, under
  `directory/subDirectory/storeId`; the client-session database is always
  in-memory and hydrated from the leader's exported snapshot. The state
  filename is keyed by the core-computed schema hash. Persistence uses
  `expo-sqlite`'s native SQLite, **not** the portable WASM SQLite build that core
  LS.SYS.RT-R09 names for browser/node/cf — a deviation
  ([.delta/DELTA-002](./.delta/DELTA-002-native-sqlite-substrate.md)).
  `refines: LS.SYS.RT-R09`
- **LSC.ADAPT.EXPO-R03 Single-session, always-leader:** Expo runs exactly one
  session per store; that session is unconditionally the leader and its lock
  status is a constant `has-lock`. Multi-session leadership handover (core
  LS.SYS.RT-R04) is **not** realized — a current limitation
  ([.delta/DELTA-001](./.delta/DELTA-001-no-handover.md)), not a settled design.
  `refines: LS.SYS.RT-R01`
- **LSC.ADAPT.EXPO-R04 In-process proxy surface:** The adapter provides the full
  `ClientSessionLeaderThreadProxy` surface; because the leader runs in-process
  every method holds a direct reference to the `syncProcessor` / state db /
  eventlog db — no serialization boundary and no RPC. `refines: LS.SYS.RT-R02,
LS.SYS.RT-R05`
- **LSC.ADAPT.EXPO-R05 Boot progress and migration report:** The adapter offers
  `{ stage: 'loading' }` to the session boot-status queue on start, forwards the
  leader-thread boot-status stream into it, and surfaces the leader's migrations
  report on the proxy's initial state. `refines: LS.SYS.RT-R03, LS.SYS.RT-R11`
- **LSC.ADAPT.EXPO-R06 Outbound devtools connection:** When devtools are enabled
  the adapter connects _outward_ over a Webmesh WebSocket to an external devtools
  server (URL resolved from the React Native dev server, or
  `EXPO_PUBLIC_LIVESTORE_DEVTOOLS_URL`); it does not host a server as Node does.
  The devtools protocol and surfaces are owned by core `07-devtools/`.
  `refines: LS-R13`
- **LSC.ADAPT.EXPO-R07 New-Architecture precondition:** The adapter refuses to
  boot (failing with an `UnknownError`) unless the React Native New Architecture
  (Fabric) is detected. This is a hard platform precondition for the adapter to
  provide a working session on Expo. `refines: LS.SYS.RT-R05`

## Open Design Questions

- **LSC.ADAPT.EXPO-DQ1 Worker / multi-threaded topology.** The leader runs in the
  app thread and the shutdown channel is a same-thread channel carrying a TODO to
  add multi-threading; whether Expo should offer a worker topology (as Node does,
  to keep a busy UI thread from stalling materialization) is uncaptured.
- **LSC.ADAPT.EXPO-DQ2 Storage-mode transparency.** Storage is always
  file-backed and `storageMode` is hardcoded `'persisted'` — there is no
  degrade-to-in-memory path and no effective-mode surface (core LS.SYS.RT-R07,
  LS.SYS.RT-R16). This may be deliberate (device filesystem is always available,
  unlike private-browsing on web), but whether Expo needs a storage-mode surface
  at all is not captured.
- **LSC.ADAPT.EXPO-DQ3 Snapshot import from a file.** The SQLite `import`
  implementation only accepts a raw byte snapshot and throws for an existing
  database handle ("importing from an existing database is not yet supported in
  expo"); whether/how import-from-file should work is open.
