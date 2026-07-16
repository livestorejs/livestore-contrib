# ElectricSQL Sync Provider — Requirements

Role: the ElectricSQL realization of LiveStore's sync-provider contract — an
eventlog persisted in Postgres and streamed to clients via Electric's
shape-based HTTP sync protocol, reached through a consumer-owned proxy.

## Context

Refines the core provider contract
([`02-system/03-sync/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync),
`LS.SYS.SYNC-*`) and root LS-R08 (sync-provider agnosticism). Package:
[`packages/@livestore/sync-electric`](../../../packages/@livestore/sync-electric).
The Cloudflare provider
([core `03-sync/03-cf/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync/03-cf),
`LS.SYS.SYNC.CF-*`) is the reference realization; where CF runs a Durable
Object as the ordering authority and arbitrates every push, Electric delegates
ordering to a Postgres primary key and never round-trips a rebase signal to the
client, so its arbitration, liveness, and cursor deviate — those deviations are
stated here, never silent. Conformance status lives in the core registry
([`03-sync/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/03-sync/realizations.md));
Electric is **not in the conformance matrix** today (the 7-provider suite,
`tests/sync-provider/`, does not exercise contrib providers).

## Requirements

- **LSC.SYNC.ELECTRIC-R01 Proxy-mediated HTTP provider:** The provider realizes
  `SyncBackend` as HTTP `GET` (pull), `POST` (push), and `HEAD` (ping) against a
  consumer-owned endpoint that proxies to an Electric sync service; the client
  never holds Electric secrets, which are injected proxy-side by
  `makeElectricUrl`. `refines: LS.SYS.SYNC-R02, LS-R08`
- **LSC.SYNC.ELECTRIC-R02 Ordering delegated to Postgres; no client rebase
  signal:** Total order is enforced by the Electric-backed eventlog table
  (`seqNum` primary key), not by a client-side head-chain check; the client
  models no `ServerAheadError`, so a push conflict surfaces as `UnknownError`
  (the defect family) and does **not** trigger the core rebase-and-retry
  recovery — a current limitation
  ([.delta/DELTA-001](./.delta/DELTA-001-no-rebase-signal.md)), not a settled
  design. `refines: LS.SYS.SYNC-R01, LS.SYS.SYNC-R03`
- **LSC.SYNC.ELECTRIC-R03 Shape-based live pull:** Pull streams Electric shape
  changes via HTTP long-poll (`pullLive: true`); Electric closes the long-poll
  after ~20 s with a 204 and the client retries at the same offset. `refines:
  LS.SYS.SYNC-R02`
- **LSC.SYNC.ELECTRIC-R04 Provider-opaque offset+handle cursor:** The pull
  cursor's provider metadata is `{offset, handle}`, read from Electric's
  `electric-offset` / `electric-handle` response headers; the engine persists
  and replays it (`syncMetadataJson`). The core global sequence number does not
  drive Electric pulls — navigation is by Electric's own offset. `refines:
  LS.SYS.SYNC-R06`
- **LSC.SYNC.ELECTRIC-R05 Unknown-remaining pagination:** `pullPageInfoKnown:
  false`; pull responses carry only `NoMore` or `MoreUnknown`, never
  `MoreKnown`, because Electric's immutable-cache design hides the remaining
  count until the stream is drained. `refines: LS.SYS.SYNC-R05`
- **LSC.SYNC.ELECTRIC-R06 Connectivity via HEAD ping:** `connect`, `ping`, and
  the `isConnected` signal are realized by `HEAD` requests to the ping endpoint
  on a background interval; a same-origin pull endpoint short-circuits `connect`
  to a no-op. `refines: LS.SYS.SYNC-R02`
- **LSC.SYNC.ELECTRIC-R07 Schema-defined boundaries with versioned Postgres
  persistence:** Push/pull payloads are schema-encoded wire types; the eventlog
  table is `eventlog_{PERSISTENCE_FORMAT_VERSION}_{storeId}` (bumping the version
  soft-resets by renaming the table, orphaning old data; over-long names hash the
  storeId). Because Electric streams a Postgres shape, only inserts are
  contract-valid — a streamed `update`/`delete` signals direct eventlog mutation
  and is rejected with `InvalidOperationError`. `refines: LS.SYS-R02`

## Open Design Questions

- **LSC.SYNC.ELECTRIC-DQ1 Rejection & convergence model.** With no
  `ServerAheadError`, how should a concurrent-writer conflict surface so the
  engine rebases and reconverges (as CF does) rather than erroring out as
  `UnknownError`? The server-side conflict handling lives in the consumer's
  proxy/DB and is out of this package. See
  [.delta/DELTA-001](./.delta/DELTA-001-no-rebase-signal.md).
- **LSC.SYNC.ELECTRIC-DQ2 Cursor/metadata shape.** `handle` is stored per event
  but is identical across every event of a shape (a `// TODO move this into some
  kind of "global" sync metadata`); whether it should move to a per-store
  metadata slot rather than riding each event's cursor is open.
- **LSC.SYNC.ELECTRIC-DQ3 Shape-handle rotation.** When Electric rotates a shape
  handle it answers 409; the client's resync-from-scratch path is a sketched
  `notYetImplemented` TODO, so live pull currently dies on rotation — a liveness
  gap, not a designed non-obligation.
- **LSC.SYNC.ELECTRIC-DQ4 Transport bounds.** Unlike the Cloudflare transports'
  100-event / 900 kB caps (core LS.SYS.SYNC-R04), the Electric provider bounds
  and chunks nothing — the whole batch is POSTed as one JSON body; Electric,
  Postgres, and proxy payload limits are uncaptured.
