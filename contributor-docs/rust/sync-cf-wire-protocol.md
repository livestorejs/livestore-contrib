# LiveStore CF sync: WebSocket wire protocol

Everything here was checked against a running local backend (wrangler dev, 2026-11-20,
effect 4.1.4). Real captures are in [`rust/fixtures/wire/`](../../rust/fixtures/wire) (one file per session; each
entry is `{dir, raw, json}` where `raw` is the exact text frame).

Sources (core, under `repos/livestore/`): `packages/@livestore/sync-cf/src/common/{ws-rpc-schema,sync-message-types,mod}.ts`,
`src/client/transport/ws-rpc-client.ts`, `src/cf-worker/do/{durable-object,pull,push}.ts`,
`node_modules/.pnpm/effect@4.1.4/.../src/rpc/{RpcMessage,RpcSerialization}.ts`.

## 1. Start the local backend (reuse for integration tests)

`rust/scripts/test-live.sh` does this for the tests. By hand, from the contrib root after `pnpm:install`:

```bash
cd repos/livestore/tests/sync-provider/src/providers/cloudflare
../../../../../packages/@livestore/utils-dev/node_modules/.bin/wrangler dev \
  --config wrangler-do-sqlite.toml --port 8787 --persist-to /tmp/livestore-wrangler-state
# ready when the log prints: [wrangler:info] Ready on http://localhost:8787
```

- Worker: `tests/sync-provider/src/providers/cloudflare/test-worker.ts` (same one the TS
  sync-provider test suite uses). Storage: Durable Object SQLite.
- **No auth, no schema check.** Any `storeId` works; each storeId gets its own DO (fresh,
  empty eventlog). Use a unique storeId per test (e.g. `rust-<timestamp>`) instead of resetting.
- The server never looks at event names/args: any JSON `args` is accepted.
- Use `--persist-to` with a throwaway dir to start clean; delete it to wipe all stores.

Capture scripts (rerun against a live backend):

```bash
cd rust/fixtures/wire
node capture-raw.mjs ws://localhost:8787 .          # hand-written frames (like Rust would)
node capture-ts-client.mjs http://localhost:8787 capture-1 ts-client-session.json  # real TS client
```

## 2. Connection

```
ws://localhost:8787/?storeId=<storeId>&transport=ws[&payload=<payload>]
```

- Path is ignored by `makeWorker`/the test worker; only query params matter. `transport=ws`
  is required (`http` would route to the HTTP transport; anything else → 400/not a sync request).
- `storeId` selects the Durable Object (`idFromName(storeId)`).
- `payload` (optional) is arbitrary JSON, **double URI-encoded**: the schema is
  `StringFromUriComponent → fromJsonString(Json)`, and then URL-param serialization encodes
  again. TS client produces
  `payload=%257B%2522authToken%2522%253A%2522insecure-token%2522%257D`
  for `{"authToken":"insecure-token"}`. Rust: `urlencode(urlencode(json_string))`.
- Auth: the deployed app's worker may run `validatePayload(payload, {storeId, headers})` on
  the upgrade request (reject → HTTP error, no upgrade). The DO may also be configured with
  `forwardHeaders` (e.g. `cookie`, `authorization`) which are captured from the **upgrade
  request headers** and handed to `onPush`/`onPull`. So: put the token in `payload` and/or
  in upgrade headers, depending on the app. The test worker checks nothing.
- No subprotocol, no handshake message. The connection is usable immediately after the
  upgrade. All frames are **text** frames containing one JSON value.
- The DO uses WebSocket hibernation; this is invisible to the client except as noted in §6.

## 3. Envelope (Effect RPC, `RpcSerialization.json`)

Each frame is one JSON object (the decoder also accepts a JSON array of messages, but
neither side sends arrays in practice). Every message has `_tag`.

### Client → server

| `_tag` | Shape | Notes |
|---|---|---|
| `Request` | `{"_tag":"Request","id":<id>,"tag":"SyncWsRpc.Pull"\|"SyncWsRpc.Push","payload":{...},"headers":[]}` | `headers` is `[[k,v],...]`, required (send `[]`). Optional `traceId`,`spanId`,`sampled` (TS client sends them; omit in Rust). |
| `Ack` | `{"_tag":"Ack","requestId":<id>}` | Required after **each** `Chunk` of a stream, or the server stops sending (see §4). |
| `Interrupt` | `{"_tag":"Interrupt","requestId":<id>}` | Cancel a request (used to end a live pull). |
| `Ping` | `{"_tag":"Ping"}` | Exact bytes matter: the DO auto-responds to the literal string `{"_tag":"Ping"}`. |
| `Eof` | `{"_tag":"Eof"}` | Not needed. |

`id`: string **or** number; the server echoes it back verbatim as `requestId` (both verified:
`10`, `"live-1"`). TS client uses incrementing numbers starting at `0` per connection.
Use numbers or short strings; ids must be unique among in-flight requests on a socket.

### Server → client

| `_tag` | Shape |
|---|---|
| `Pong` | `{"_tag":"Pong"}` |
| `Chunk` | `{"_tag":"Chunk","requestId":<id>,"values":[<PullResponse>, ...]}` (in practice always exactly one value) |
| `Exit` | `{"_tag":"Exit","requestId":<id>,"exit":<Exit>}` — terminal for that request |
| `Defect` | `{"_tag":"Defect","defect":...}` — connection-level protocol error (e.g. unparsable frame); not tied to a request |

`Exit` encoding:

```json
{"_tag":"Success","value": <success>}            // Push: {}   stream (Pull): null
{"_tag":"Failure","cause":[ <reason>, ... ]}
// reason is one of:
{"_tag":"Fail","error": <typed error>}           // expected domain errors, see §5
{"_tag":"Die","defect": "<string message>"}     // bug / schema decode failure / unknown tag
{"_tag":"Interrupt","fiberId": 18}              // request was interrupted (e.g. after our Interrupt)
```

### Schema encodings used in payloads

- `Option<T>`: `{"_tag":"None"}` / `{"_tag":"Some","value":T}`.
- Tagged structs carry `_tag` (e.g. `SyncMetadata` → `{"_tag":"SyncMessage.SyncMetadata","createdAt":"ISO"}`).
- Sequence numbers (`seqNum`, `parentSeqNum`, `eventSequenceNumber`): plain JSON integers. Root parent is `0`; first event has `seqNum: 1`.
- `Schema.optional` fields: just omit them.

### Event (`LiveStoreEvent.Global.Encoded`)

```json
{"name":"todoCreated-v1","args":{...any JSON...},"seqNum":2,"parentSeqNum":1,
 "clientId":"ts-client","sessionId":"ts-session"}
```

All six fields required. `args` is the **encoded** form of the event's args schema (opaque to the server).

## 4. Pull (`SyncWsRpc.Pull`, streaming)

Request payload:

```json
{"storeId":"capture-1","payload":<optional json>,"live":false,
 "cursor":{"_tag":"None"}}
{"storeId":"capture-1","live":true,
 "cursor":{"_tag":"Some","value":{"backendId":"dyxIUOkAmn4JgAiK7Szry","eventSequenceNumber":1}}}
```

- `cursor` None → from the beginning. Some → events with `seqNum > eventSequenceNumber`
  (verified: cursor 1 returned seq 2,3). `cursor.backendId` must match the server's or you
  get `BackendIdMismatchError`.
- `payload` inside the request body is optional. The TS client repeats the URL payload here.
  The URL payload goes to the worker's `validatePayload`; the **body** payload is what the DO's
  `onPull`/`onPush` hooks receive. So send the same value in both places if the app uses auth.
- `storeId` in the body should equal the URL's storeId.

Each `Chunk.values[0]` is a `PullResponse`:

```json
{"batch":[{"eventEncoded":<Event>,
           "metadata":{"_tag":"Some","value":{"_tag":"SyncMessage.SyncMetadata","createdAt":"2026-11-20T09:04:24.154Z"}}}],
 "pageInfo":{"_tag":"MoreKnown","remaining":150} | {"_tag":"NoMore"},
 "backendId":"dyxIUOkAmn4JgAiK7Szry"}
```

(`pageInfo` may also be `{"_tag":"MoreUnknown"}` per schema; not emitted by this backend.)

Semantics (all verified):

1. **History phase**: up to 100 events per chunk (and ≤ 900 000 bytes). `pageInfo.remaining`
   counts events still to come in this history. Last history chunk has `NoMore`. Empty store
   → exactly one chunk with `batch: []`, `NoMore`.
2. **Ack backpressure**: the server sends the next history chunk only after it receives
   `{"_tag":"Ack","requestId":<id>}` for the previous one. Without Acks you get 1 chunk and
   then silence (`push-minimal-and-paginated-pull.json`).
3. `live:false`: after the last chunk is acked → `Exit` `{"_tag":"Success","value":null}`.
4. `live:true`: no Exit after history. The stream stays open forever. **`NoMore` does not
   mean the stream ended** in live mode, only "caught up".
5. **Live updates**: whenever any client pushes, the DO writes
   `{"_tag":"Chunk","requestId":<your live pull id>,"values":[PullResponse]}` directly on
   every socket that has an open live pull — including the pusher's own socket (that is how
   the pusher sees its events confirmed). These have `metadata: Some{createdAt}` and
   `pageInfo: NoMore`. They bypass the Ack mechanism (sending an Ack anyway is harmless; TS does).
   Ordering: a push's broadcast chunk arrives **before** that push's `Exit` (server
   publishes, then acks the push).
6. Ending a live pull: send `Interrupt`; server replies
   `Exit {"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":N}]}`. Treat that as a normal end.
7. Live chunks may also include events you already have (e.g. a push lands while history is
   still streaming); dedupe by `seqNum` (ignore `seqNum <= last applied`).

## 5. Push (`SyncWsRpc.Push`, unary)

```json
{"_tag":"Request","id":2,"tag":"SyncWsRpc.Push","headers":[],
 "payload":{"storeId":"capture-1","payload":<optional>,
            "batch":[<Event>, ...],
            "backendId":{"_tag":"Some","value":"dyxIUOkAmn4JgAiK7Szry"}}}
```

- `backendId` is `Option`: `{"_tag":"None"}` is accepted (e.g. before the first pull).
- `batch`: ≤ 100 events and ≤ 900 000 bytes encoded (client must split; the server rejects
  oversize frames at the platform level). Events must be contiguous; the server only checks
  `batch[0].parentSeqNum == currentHead`, then appends and sets head = last `seqNum`.
- Empty batch → immediate success.
- Success: `{"_tag":"Exit","requestId":2,"exit":{"_tag":"Success","value":{}}}`.

Errors (as `exit.cause[0]` with `_tag:"Fail"`):

```json
{"_tag":"ServerAheadError","minimumExpectedNum":251,"providedNum":4}
{"_tag":"BackendIdMismatchError","expected":"LBxDEJns-rQDSFA5f_Hyy","received":"wrong-backend-id"}
{"_tag":"UnknownError", ...}   // e.g. onPush hook threw (auth rejection lands here)
```

- `ServerAheadError`: server head (`minimumExpectedNum`) ≠ your first `parentSeqNum`
  (`providedNum`). Client must pull the missing events, rebase its pending local events on top, and retry.
- `BackendIdMismatchError` (push or pull): the backend was reset/replaced. Client must drop
  its synced state and resync from scratch (cursor None).
- `Die` causes (schema decode failures, unknown tags) look like
  `{"_tag":"Die","defect":"Missing key\n  at [\"live\"]"}` / `"Unknown request tag: SyncWsRpc.Nope"`.
- A non-JSON frame yields a connection-level `{"_tag":"Defect","defect":{}}`.

## 6. backendId

- A random nanoid (21 chars) generated once per DO (per storeId) and stored in its SQLite
  context table. Changes only if the backend storage is reset.
- Delivered in every `PullResponse.backendId`. Client stores it (persist alongside the
  eventlog) and sends it in pull `cursor.backendId` and push `backendId`.
- The TS client strips `backendId` from pull results and keeps it in a KeyValueStore
  (`backendIdHelper.lazySet`); it sends `None` on push only if it never pulled.

## 7. Ping / keepalive / reconnect

- TS client sends `{"_tag":"Ping"}` right after connecting (that is its "connect" check) and
  then every 10 s; if no `Pong` within 10 s, it marks itself disconnected.
- `Pong` is a Cloudflare auto-response (`setWebSocketAutoResponse`) matched on the exact
  string `{"_tag":"Ping"}` — no whitespace, no extra fields — so it works without waking a
  hibernated DO. A differently serialized ping would wake the DO and go through Effect RPC.
- On disconnect, everything in flight is lost. Reconnect (TS: exponential backoff from 1 s,
  capped at 30 s, jittered), then re-issue the live pull with the cursor = last applied
  seqNum, and retry unacknowledged pushes (expect `ServerAheadError` if they already landed:
  you'll see them in the pull).
- Hibernation: live pulls survive DO hibernation (request ids live in the socket attachment
  and broadcasts are written raw). Nothing for the client to do.

## 8. Rust client checklist

1. Open `ws(s)://host/?storeId=<id>&transport=ws[&payload=<urlenc(urlenc(json))>]`, plus any
   auth headers the deployment's `forwardHeaders`/`validatePayload` expects.
2. Send exactly `{"_tag":"Ping"}`; expect `{"_tag":"Pong"}`. Repeat every ~10 s; reconnect if no Pong in 10 s.
3. Keep a per-connection request-id counter; route incoming `Chunk`/`Exit` by `requestId`
   (handle both number and string ids). Handle top-level `Defect` and `Pong`.
4. Pull: send `Request` with `tag:"SyncWsRpc.Pull"`, `headers:[]`, `live:true`, cursor
   `None` or `Some{backendId, eventSequenceNumber}`. **Ack every Chunk.** Apply
   `values[*].batch[*].eventEncoded` in order, dedupe by `seqNum`, remember `backendId`.
   `MoreKnown.remaining` is useful for progress only.
5. Push: `tag:"SyncWsRpc.Push"`, events with `parentSeqNum` chained from the current
   server head, ≤100 events / ≤900 KB per request, `backendId` as Option. Success = `Exit`
   Success `{}`; your own events also arrive on your live pull.
6. Map failures: `Fail.ServerAheadError` → pull/rebase/retry; `Fail.BackendIdMismatchError`
   → full resync; `Fail.UnknownError` / `Die` → surface as error; `Interrupt` cause → stream ended.
7. On reconnect: new socket, new request ids, re-pull from last cursor, re-push pending.
8. Encode `Option` as `{"_tag":"None"}`/`{"_tag":"Some","value":...}` and omit (not null)
   optional fields like `payload`.

## 9. Fixture index (`rust/fixtures/wire/`)

| File | Shows |
|---|---|
| `ts-client-session.json` | Real TS `makeWsSync` client: connect ping, initial pull on empty store, live pull, 2 pushes + broadcast chunks, Interrupt, cursor pull, ServerAheadError, keepalive ping at 10 s |
| `ping-pong.json` | Literal ping/pong |
| `push-minimal-and-paginated-pull.json` | Pushes with `backendId: None` and string ids; 250-event pull in 3 chunks (`MoreKnown 150` → `MoreKnown 50` → `NoMore`) gated by Acks |
| `pull-live-update.json` + `push-from-other-connection.json` | Live pull from cursor 249; another socket pushes 251; broadcast chunk; Interrupt → Exit(Interrupt) |
| `error-server-ahead.json` | ServerAheadError |
| `error-backend-id-mismatch.json` | BackendIdMismatchError on push and on pull |
| `error-malformed.json` | Die on bad payload, Die on unknown tag, Defect on non-JSON |
| `payload-query-param.json` | `payload` query encoding; nested/null args |
| `capture-raw.mjs`, `capture-ts-client.mjs` | Scripts that produced the above |
