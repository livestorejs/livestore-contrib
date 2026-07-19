# Node Adapter — Requirements

Role: the Node.js realization of LiveStore's adapter/runtime contract — an
in-process or worker-thread leader over filesystem or in-memory WASM SQLite,
for servers, CLIs, and tests.

## Context

Refines the core adapter/runtime contract
([`02-system/04-runtime/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime),
`LS.SYS.RT-*`) and the core determinism requirement (LS-R05). Package:
[`packages/@livestore/adapter-node`](../../../packages/@livestore/adapter-node).
The web adapter
([core `04-runtime/01-web/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime/01-web))
is the reference realization; Node has no SharedWorker, no OPFS, and no
`navigator.locks`, so its topology, persistence, and leadership deviate — those
deviations are stated here, never silent. Conformance status lives in the core
adapter registry
([`04-runtime/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/04-runtime/realizations.md));
the shared adapter conformance suite is contracted but unbuilt (core
LS.SYS.VER.CONF-R03).

## Requirements

- **LSC.ADAPT.NODE-R01 Two topologies, one session contract:** The adapter
  offers a single-threaded variant (`makeAdapter` — leader runs in-process) and
  a worker variant (`makeWorkerAdapter` — leader runs in one
  `node:worker_threads` worker, serialized pool of size 1); both return the
  same `ClientSession`. `refines: LS.SYS.RT-R01, LS.SYS.RT-R05`
- **LSC.ADAPT.NODE-R02 Filesystem or in-memory WASM SQLite:** Persistence is
  selected by the `storage` option (`fs` | `in-memory`), not a separate factory.
  The `fs` variant stores the state and eventlog databases as files under
  `baseDirectory/storeId` on the LiveStore WASM SQLite build (not a native
  binding); the client-session database is always in-memory and hydrated from
  the leader's exported snapshot. `refines: LS.SYS.RT-R07, LS.SYS.RT-R09`
- **LSC.ADAPT.NODE-R03 Single-session, always-leader:** Node runs exactly one
  session per store; that session is unconditionally the leader and its lock
  status is a constant `has-lock`. Multi-session leadership handover (core
  LS.SYS.RT-R04) is **not** realized — a current limitation
  ([.delta/DELTA-001](./.delta/DELTA-001-no-handover.md)), not a settled design;
  concurrent sessions on one `storeId` are unsupported and warned against.
  `refines: LS.SYS.RT-R01`
- **LSC.ADAPT.NODE-R04 Proxy surface with a topology-dependent serialization
  split:** The adapter provides the full `ClientSessionLeaderThreadProxy`
  surface. Single-threaded calls hold direct in-process references (no
  serialization); the worker variant is an RPC boundary over schema-tagged
  requests with transferable payloads, and transport failures surface as
  defects. `refines: LS.SYS.RT-R02, LS.SYS.RT-R05`
- **LSC.ADAPT.NODE-R05 Boot progress and migration report:** The adapter streams
  boot status into the session's boot-status queue and surfaces the leader's
  migrations report on the proxy's initial state; in the worker variant both
  cross the worker boundary. `refines: LS.SYS.RT-R03, LS.SYS.RT-R11`
- **LSC.ADAPT.NODE-R06 Node devtools server:** When devtools are enabled the
  adapter starts a Node HTTP + WebSocket devtools server (Webmesh transport,
  optional Vite middleware for the UI); the devtools protocol and surfaces are
  owned by core `07-devtools/`. `refines: LS-R13`

## Open Design Questions

- **LSC.ADAPT.NODE-DQ1 WAL on Node.** The `fs` variant opens databases without
  write-ahead logging (a `// TODO enable WAL for nodejs` marks it); whether WAL
  should be the default, and its durability/concurrency implications for server
  workloads, is uncaptured.
- **LSC.ADAPT.NODE-DQ2 Worker-variant sync configuration.** Single-threaded
  accepts a `sync` option directly, but the worker variant configures the sync
  backend inside the worker entry file instead — whether these two configuration
  paths should converge is open.
