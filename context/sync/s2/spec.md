# S2 Sync Provider — Spec

Specifies the S2 provider (`packages/@livestore/sync-s2`) at the
realization-contract level. Builds on [requirements.md](./requirements.md); the
mechanism-agnostic provider contract is core
[`03-sync/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/03-sync/spec.md).
Citations are `src/…:line` within the package.

## Status

Draft.

## Entry & Surface

`makeSyncBackend(options): SyncBackendConstructor<SyncMetadata>`
(`src/sync-provider.ts:95`) returns the full `SyncBackend` object
(`src/sync-provider.ts:248`): `connect`, `pull`, `push`, `ping`, `isConnected`,
`metadata`, and `supports`. Options (`SyncS2Options`, `src/sync-provider.ts:57`):
`endpoint` is one URL or a `{ push, pull, ping }` triple
(`src/sync-provider.ts:100-102`); optional `ping` (enable/interval/timeout,
defaults 10 s / 10 s) and `retry` (per-op `Schedule`, default
`recurs(2) ∘ spaced(100ms)`, `src/sync-provider.ts:81`).

The package has two public exports (`src/mod.ts:1-8`; `package.json` `exports`):
`.` (the provider) and `./s2-proxy-helpers` — reusable helpers for building the
S2-facing side of an API proxy (URL/header construction, chunked push requests,
canned responses). The proxy itself is app-owned; the client never imports the
S2 wire client directly.

## LiveStore → S2 Mapping

- **Stream:** `storeId` → sanitized S2 stream name
  (`[^a-zA-Z0-9_-]` → `-`, truncated to 100 chars; `src/make-s2-url.ts:6`). One
  stream per store.
- **Record:** each `LiveStoreEvent.Global.Encoded` is `JSON.stringify`-ed into
  the S2 record body (`src/limits.ts:73`); record headers are unused
  (`src/sync-provider.ts:16`).
- **Sequence spaces are independent by design** (`src/sync-provider.ts:17-19`,
  `src/types.ts:3-12`): S2 assigns a physical `seq_num` per record; LiveStore's
  logical `seqNum` lives inside the body and is preserved. `S2SeqNum` is a
  branded non-negative int (`src/types.ts:13-15`) precisely to prevent mixing
  the two. The source ties the decoupling to future compaction, so the
  positions are not assumed 1:1 forever.

## Cursor & Metadata

The provider-opaque metadata is `SyncMetadata = { s2SeqNum }`
(`src/types.ts:22-25`). On pull, the S2 read position is taken from the cursor's
metadata `s2SeqNum`, defaulting to `'from-start'` when absent
(`src/sync-provider.ts:138-142`); on the proxy's S2 side the next read is
`s2SeqNum + 1` (`from-start` → 0, `src/s2-proxy-helpers.ts:130-132`). Each
decoded record carries its `s2SeqNum` back as metadata
(`src/decode.ts:25-27`), which the engine persists and replays verbatim.

## Pull

Pull is SSE for both modes (`src/sync-provider.ts:130`, `:250-260`). `args`
(`storeId`, `payload`, `s2SeqNum`, `live`) are JSON-encoded into the
`?args=` query param (`src/api-schema.ts:6-22`; `src/sync-provider.ts:144-145`)
and the request sets `accept: text/event-stream` (`:148`). SSE frames are
dispatched by event name (`src/sync-provider.ts:155-188`):

- `ping` → dropped (`:158`);
- `error` → `UnknownError` (`:159-161`);
- `batch` → decode `ReadBatch` (`src/http-client-generated.ts:560`), map records
  to `{ eventEncoded, metadata }` dropping bodiless records
  (`src/decode.ts:16-28`);
- `message` `[DONE]` → end-of-stream (`:185`);
- anything else → `shouldNeverHappen` (`:188`).

**Pagination.** From a `batch` frame the provider computes
`remaining = max(0, tail.seq_num − (lastS2SeqNum + 1))` and emits
`pageInfoMoreKnown(remaining)` when positive, else `pageInfoNoMore`
(`src/sync-provider.ts:166-182`); `tail` is the stream head position
(`src/http-client-generated.ts:566`). Despite this, `supports.pullPageInfoKnown`
is `false` (`src/sync-provider.ts:313`), so the engine treats page info as
advisory (requirements DQ1).

**Non-live** pull runs one SSE pass with `wait=0` on the proxy's S2 read so S2
returns at the tail (`src/s2-proxy-helpers.ts:137-142`), and emits an empty
`NoMore` item if the stream yielded nothing (`src/sync-provider.ts:254-259`).
**Live** pull (`ssePull`, `:197-246`) loops: the first pass is non-live, then it
reconnects live from the last item's cursor
(`concatWithLastElement` + `computeNextCursor`, `:203-242`), so a closed tail
resumes at the next unseen record.

## Push

`push(batch)` pre-chunks via `chunkEventsForS2` (`src/sync-provider.ts:290`;
`src/limits.ts:106`) to honor S2's limits: ≤1 MiB metered per record and per
batch, ≤1000 records (`src/limits.ts:10-20`); metered bytes are
`8 + 2·headerCount + headerBytes + bodyBytes` in UTF-8 (`src/limits.ts:42-51`).
Each chunk is `POST`ed as `{ storeId, batch }` (`src/api-schema.ts:13-16`) to the
push endpoint, filtered on `status ok`, decoded as `{ success }`
(`src/api-schema.ts:24`), and retried on the push schedule
(`src/sync-provider.ts:292-302`).

The push carries **no ordering guard**: the request body is `{ storeId, batch }`
only, and the S2-facing helper `buildPushRequests` appends records with no
`match_seq_num` fence (`src/s2-proxy-helpers.ts:159-178`), though S2 exposes one
(`match_seq_num`, `src/http-client-generated.ts:603`). There is no
`ServerAheadError` path — see [.delta/DELTA-001](./.delta/DELTA-001-no-fast-forward.md).

## Liveness & Errors

`ping` issues `HEAD` on the ping endpoint under a timeout (default 10 s); success
sets `isConnected: true`, `TimeoutException` sets it `false`
(`src/sync-provider.ts:112-119`). When enabled it runs on an interval in a
forked scope (`:122-124`). `connect` is a no-op when the pull endpoint is
same-origin, else it pings (`:126-128`). Every other failure — non-2xx pull/push,
SSE `error` frames, and `S2LimitExceededError` (mapped with a descriptive `note`
and payload) — becomes `UnknownError` (`src/sync-provider.ts:159-161`,
`:264-288`). The typed rejection/backend families are not reconstructed — see
[.delta/DELTA-002](./.delta/DELTA-002-untyped-failures.md).

## Capabilities

`supports = { pullPageInfoKnown: false, pullLive: true }`
(`src/sync-provider.ts:312-315`); `metadata` reports name, description,
`protocol: 'http'`, and the endpoint (`:306-311`).

## Proxy Helpers

`./s2-proxy-helpers` (`src/s2-proxy-helpers.ts`) is the S2-facing toolkit for an
app-owned proxy: `S2Config` (basin/token/base URLs, `lite` header-routing for
self-hosted `s2-lite`, `:13-29`), URL builders (`getStreamRecordsUrl` maps
`seq_num`/`count`/`clamp`/`wait`, `:45-65`), header builders (`s2-format: raw`,
bearer auth, `:68-84`), `ensureBasin`/`ensureStream` provisioning (best-effort,
errors swallowed, `:87-116`), `buildPullRequest`/`buildPushRequests` (the latter
applies the same chunking, `:159-178`), and canned `Response` builders
(`:181-206`). Pull-arg decoding for the proxy's GET side mirrors the client's
encoding (`decodePullArgsFromSearchParams`, `src/make-s2-url.ts:11`).
