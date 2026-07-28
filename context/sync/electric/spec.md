# ElectricSQL Sync Provider — Spec

Specifies the Electric provider (`packages/@livestore/sync-electric`) at the
realization-contract level. Builds on [requirements.md](./requirements.md); the
mechanism-agnostic contract is core
[`03-sync/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/03-sync/spec.md),
and the reference realization is core
[`03-cf/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/03-sync/03-cf/spec.md).
Citations are `src/…:line` within the package.

## Status

Draft.

## Topology

```
client (SyncBackend impl, src/index.ts) ──GET/POST/HEAD──▶
  consumer proxy (app API layer; makeElectricUrl injects secrets) ──▶
    Electric sync service ──▶ Postgres (eventlog_<V>_<storeId>)
```

`makeSyncBackend` builds a `SyncBackend.SyncBackendConstructor<SyncMetadata>`
(`src/index.ts:196`) whose factory (`:198`) captures `storeId` and an
auth `payload`. Unlike CF — where the client reaches the ordering authority
directly over WS/HTTP/DO-RPC — the Electric client talks only to a
consumer-owned endpoint; the secret-bearing Electric URL is assembled
server-side by `makeElectricUrl` in a trusted proxy (`src/make-electric-url.ts:6`,
`:45`), injecting `source_id`/`source_secret` (Electric Cloud) or `api_secret`
(self-hosted) (`:65`–`:73`). `endpoint` is either one URL or a
`{push, pull, ping}` split (`src/index.ts:121`, `:201`–`:203`).

## Push & Ordering

`push` POSTs the batch as one schema-encoded body
(`ApiSchema.PushPayload`, `src/api-schema.ts:4`) and inspects `{ success }`
(`src/index.ts:366`–`:379`). There is no head-chain arbitration in the client
and no `ServerAheadError`: the ordering authority is the Postgres eventlog
table, whose `seqNum` is the PRIMARY KEY (`src/make-electric-url.ts:123`), so
concurrent writers are linearized at the DB. A rejected push (`success: false`
or non-2xx) is mapped to `UnknownError` (`src/index.ts:374`, `:377`) — the
core defect family, which is _surfaced, not rebased_. This does **not** realize
the rebase-and-retry recovery the core taxonomy assigns to push rejection
(LSC.SYNC.ELECTRIC-R02, [.delta/DELTA-001](./.delta/DELTA-001-no-rebase-signal.md)).
The batch is POSTed whole — no per-message event cap or payload chunking, unlike
the CF transports (LSC.SYNC.ELECTRIC-DQ4).

## Pull

`pull` is a `Stream.unfoldEffect` (`src/index.ts:335`) seeded from the cursor's
provider metadata (`Option.flatMap((_) => _.metadata)`, `:335`) — the core
global sequence number is not used to drive Electric. Each step calls `runPull`
(`:207`), which GETs `${pullEndpoint}?args=${argsJson}` with a schema-encoded
`PullPayload` carrying `{storeId, handle, payload, live}` (`:225`–`:228`).

Status handling (`:232`–`:268`):

- `401` → `UnknownError` (unauthorized); `400` (table absent) → empty result
  `Option.some([[], none])`; `204` (Electric's ~20 s long-poll close) → retry at
  the same handle; other non-2xx → `UnknownError`.
- `409` (shape handle rotated / not found) → `notYetImplemented` (`:252`): the
  resync-from-scratch path is only a TODO, so live pull dies on rotation
  (LSC.SYNC.ELECTRIC-DQ3).

The next cursor is read from response headers `electric-offset` /
`electric-handle` (`ResponseHeaders`, `:103`; `nextHandle`, `:259`). Insert
items decode via `LiveStoreEventGlobalFromStringRecord` (numeric fields parsed
from strings, `:70`–`:78`); each carries the shared `{offset, handle}` as its
metadata (`:287`–`:290`). A streamed `update`/`delete` (`ResponseItemInvalid`,
`:88`) means the eventlog was mutated directly and raises `InvalidOperationError`
(`src/index.ts:20`, `:279`–`:285`).

The unfold emits batches with `hasMore: true` while data flows, emits once even
when empty (first call or `live`), and stops on an empty non-live batch
(`:343`–`:355`). `pageInfo` is `MoreUnknown` when more may follow, else `NoMore`
(`:358`–`:361`) — never `MoreKnown`, because `pullPageInfoKnown: false` (`:392`).

## Cursor & Metadata

`SyncMetadata = { offset: string, handle: string }` (`src/index.ts:147`). The
engine persists and replays this opaque blob (`syncMetadataJson`) without
interpreting it (core LS.SYS.SYNC-R06). `handle` is stored on every event's
metadata although it is identical across a shape (a `// TODO move this into some
kind of "global" sync metadata`, `:149`) — LSC.SYNC.ELECTRIC-DQ2.

## Connectivity

`isConnected` is a `SubscriptionRef<boolean>` (`src/index.ts:200`). `ping` issues
a `HEAD` to the ping endpoint under a timeout (default 10 s) and sets
`isConnected` true, or false on `TimeoutException` (`:307`–`:316`); unless
disabled it runs on a background interval (default 10 s, `:318`–`:323`).
`connect` is a no-op when the pull endpoint is same-origin (assumed already
connected) and otherwise a `ping` (`:301`–`:303`, `:327`–`:328`).

## Persistence & Versioning

The eventlog table is `eventlog_{PERSISTENCE_FORMAT_VERSION}_{storeId}`
(currently 6, `src/make-electric-url.ts:130`, `:91`), the storeId sanitized to
`[a-zA-Z0-9_]` and always quoted for Postgres (`:64`, `:90`). Names over 63
chars fall back to `eventlog_<V>_hash_<hashedStoreId>` (`:93`–`:101`). Bumping
`PERSISTENCE_FORMAT_VERSION` renames the table — a soft reset that orphans old
rows (`:106`–`:130`), mirroring CF's `PERSISTENCE_FORMAT_VERSION`. The schema is
`seqNum` (INTEGER PK), `parentSeqNum`, `name`, `args` (JSONB), `clientId`,
`sessionId` (`:122`–`:129`); the proxy/server that creates the table lives with
the consumer (referenced example: `examples/web-todomvc-sync-electric/src/server/db.ts`).

## Metadata & Capabilities

`metadata` reports `{ name: '@livestore/sync-electric', description, protocol:
'http', endpoint }` (`src/index.ts:383`). `supports` is `{ pullPageInfoKnown:
false, pullLive: true }` (`:389`–`:394`).
