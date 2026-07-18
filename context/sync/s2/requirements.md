# S2 Sync Provider — Requirements

Role: the S2 realization of LiveStore's sync-provider contract — eventlog
ordering and distribution over [S2](https://s2.dev) streams, reached through a
thin HTTP "API proxy" rather than S2 directly.

## Context

Refines the core provider contract
([`02-system/03-sync/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync),
notably LS.SYS.SYNC-R01 upstream total order, LS.SYS.SYNC-R02 provider
contract, LS.SYS.SYNC-R03 typed failure taxonomy, LS.SYS.SYNC-R04 bounded
batches, LS.SYS.SYNC-R05 pagination signal, LS.SYS.SYNC-R06 provider-opaque
cursor). The Cloudflare realization
([core `03-cf/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync/03-cf))
is the reference. Package:
[`packages/@livestore/sync-s2`](../../../packages/@livestore/sync-s2). Not yet
exercised by the core conformance matrix (see the core
[`03-sync/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/03-sync/realizations.md)
registry).

Unlike the Cloudflare realization, the provider never talks to S2 directly: it
speaks three verbs (GET pull / POST push / HEAD ping) to an application-owned
API proxy that bridges to hosted S2 or self-hosted `s2-lite`
(`src/sync-provider.ts:5-11`). Basin/stream provisioning, auth, and the proxy's
S2 wire calls are out of this package's scope — the package ships the client
plus reusable proxy helpers, not the proxy.

## Requirements

- **LSC.SYNC.S2-R01 SyncBackend over a three-verb HTTP proxy:** The provider
  realizes `connect/pull/push/ping` plus `isConnected`, `metadata`, and
  `supports` against a single HTTP proxy endpoint (or a `{push,pull,ping}`
  triple); pull is `GET /?args=…`, push is `POST /`, ping is `HEAD /`. The
  client never provisions, authenticates, or appends to S2 directly, though it
  does parse S2-native `ReadBatch`/`seq_num`/`tail` on the pull response.
  `refines: LS.SYS.SYNC-R02`
- **LSC.SYNC.S2-R02 One store, one S2 stream, decoupled sequence spaces:** A
  `storeId` maps to one sanitized S2 stream name; each LiveStore event is
  JSON-encoded into an S2 record body. The S2 stream **is** the single ordering
  authority — it linearizes writers and assigns its own physical `seq_num`,
  while the client's logical `seqNum` is carried untouched inside the body
  (R01 "arbitrates, does not renumber" holds). The fast-forward clause of R01
  (accept a push **only** when it chains onto the head) is **not** enforced —
  see [.delta/DELTA-001](./.delta/DELTA-001-no-fast-forward.md).
  `refines: LS.SYS.SYNC-R01`
- **LSC.SYNC.S2-R03 Provider-opaque S2 cursor:** The pull cursor's metadata is a
  branded `{ s2SeqNum }` struct that the engine persists (`syncMetadataJson`)
  and replays without interpreting; the provider derives the next S2 read
  position from it. `refines: LS.SYS.SYNC-R06`
- **LSC.SYNC.S2-R04 Pagination signal from the S2 tail:** Pull responses carry a
  `NoMore`/`MoreKnown(remaining)` page-info signal derived from the batch's last
  S2 `seq_num` versus the stream `tail`; the provider nonetheless declares
  `pullPageInfoKnown: false` in its capability flags
  ([LSC.SYNC.S2-DQ1](#lscsyncs2-dq1)). `refines: LS.SYS.SYNC-R05`
- **LSC.SYNC.S2-R05 Live tail with reconnection:** Both live and non-live pulls
  stream over S2 Server-Sent Events; the provider declares `pullLive: true`.
  Live pulls loop: on stream end they reconnect from the last observed cursor,
  so a dropped tail resumes without gaps or replays. `refines: LS.SYS.SYNC-R02`
- **LSC.SYNC.S2-R06 S2 batch limits realize bounded transport:** Push enforces
  S2's documented append limits (≤1 MiB metered per record and per batch, ≤1000
  records) by pre-chunking; an over-limit single record is a typed
  `S2LimitExceededError`. These S2 limits — not the Cloudflare 100-event cap —
  are this provider's realization of bounded batches. `refines: LS.SYS.SYNC-R04`
- **LSC.SYNC.S2-R07 Failure mapping:** Ping/connect timeouts flip `isConnected`
  to `false` (the offline signal); pull, push, and limit failures are mapped to
  `UnknownError` with retry on a default schedule. The typed rejection/backend
  families of the core taxonomy are not reconstructed — see
  [.delta/DELTA-002](./.delta/DELTA-002-untyped-failures.md).
  `refines: LS.SYS.SYNC-R03`

## Open Design Questions

- <a id="lscsyncs2-dq1"></a>**LSC.SYNC.S2-DQ1 pullPageInfoKnown declared false
  despite a computed remaining.** The pull path computes
  `MoreKnown(tail.seq_num − (lastS2SeqNum + 1))`, yet `supports.pullPageInfoKnown`
  is `false`, so the engine ignores it. Whether this physical remaining-record
  count reliably equals the logical remaining-event count (records may be
  filtered, e.g. bodiless), and hence whether the flag should be `true`, is
  uncaptured.
- **LSC.SYNC.S2-DQ2 Permanence of the proxy split.** The client always goes
  through an app-owned API proxy; provisioning, auth, and direct S2 calls live
  behind it. Whether a direct-to-S2 provider (no proxy) is a supported target,
  and where the arbitration of [DELTA-001](./.delta/DELTA-001-no-fast-forward.md)
  would then live, is open.
- **LSC.SYNC.S2-DQ3 Record headers unused.** Events are stored as bare bodies;
  S2 record headers are not used, and the source pins the physical/logical
  sequence decoupling to *future* compaction. What metadata (fencing token,
  logical head) headers should carry is uncaptured.
