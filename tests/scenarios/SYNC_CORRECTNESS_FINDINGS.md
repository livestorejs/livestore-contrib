# LiveStore Sync Correctness Findings

This ledger records adversarial Scenario-runner results. It distinguishes a
LiveStore behavior from missing runner evidence: a timeout or host transport
failure is not promoted to a new engine finding unless another profile exposes
the underlying engine failure.

## Tested foundation

- Contrib revision: `816c2a1d563ecfe15c200ad39f2ea0101914ecee`
- Latest upstream LiveStore `main` inspected: `6fff977115465f096e4e04f4b80da622ea693a5f`
- Compatible LiveStore coordination revision tested:
  `1ce3d5484c7822f06ed054ddafbc14398cabc325`
- Relationship: the compatible revision is two commits ahead of that exact
  upstream `main` revision and supplies the mock-backend observation seam used
  by the Scenario runner.
- Baseline on the compatible revision: 56/56 Scenario tests pass; the viewer
  production build passes.
- Compatibility evidence: running against upstream `main` alone produces 17
  harness failures because `makeMockSyncBackend` does not yet expose the shared
  `isConnected` subscription expected by this runner. Those failures are an
  integration-version mismatch, not LiveStore correctness findings.

## SF-01: a valid offline hotel booking can become unmaterializable during rebase

### Failure summary

Two Clients independently book the final standard hotel room. The online
booking is confirmed first. When the offline Client reconnects, replaying its
pending booking over the confirmed booking tries to materialize negative hotel
inventory. SQLite rejects the event and the Client Store shuts down instead of
recovering or presenting an application-addressable conflict.

Classification: **LiveStore sync-engine availability/correctness failure**.
The database constraint is intentionally application-defined; the engine-level
failure is that reconciliation accepts a pending event whose deterministic
replay cannot materialize, then terminates the Store without a recovery path.

### Expected versus actual behavior

- Expected: reconciliation preserves a usable Store and exposes a deterministic
  conflict/rejection outcome, or otherwise defines a recovery path that does not
  require deleting local state.
- Actual: in-process reconciliation raises `MaterializeError`, wraps the nested
  SQLite constraint as `UnknownError`, and shuts down Client A's Store. Browser
  hosting observes the resulting interrupted runtime. The process host stalls
  with unresolved heads and one pending event but loses the originating cause.

### Stable failure signature and reproducibility

The minimized in-process signature reproduced in **5/5** consecutive runs:

```text
terminal=participant-runtime-failure
participant=client-a/session-a
annotation=rebase-invalid-pending-event
instruction=reconnect-client-a
cause=CHECK constraint failed: hotel_room_inventory.available_nonnegative
trace-records=139
```

The process-profile manifestation reproduced in **3/3** runs:

```text
terminal=settlement-timeout
client-a=local e3r1, upstream e3, pending 1
client-b=local e2, upstream e3, pending 0
trace-records=962
```

The browser-profile manifestation reproduced in **3/3** runs:

```text
terminal=host-transport-failure
annotation=rebase-invalid-pending-event
instruction=reconnect-client-a
cause=All fibers interrupted without error
trace-records=122
```

Only the in-process signature contains sufficient evidence to name the SQLite
cause. The process timeout and browser transport error are corroborating host
manifestations, not separate LiveStore findings.

### Exact reproduction

Profile `in-process + mock`, seed `2002`:

```sh
GITHUB_SHA=816c2a1d563ecfe15c200ad39f2ea0101914ecee \
  pnpm --dir tests/scenarios scenario:run \
  --profile in-process \
  --scenario concurrent-hotel-booking \
  --output artifacts/sf-01-concurrent-hotel-booking.json
```

For process or browser promotion, replace `--profile in-process` with `process`
or `browser`. Browser runs in this worktree use the devenv-pinned Playwright
browsers.

### Minimized scenario

`tests/scenarios/src/corpus/scenarios/retained/findings/concurrent-hotel-booking.ts`

The reproducer is reduced to two Clients, one session each, three application
events (initial inventory plus two bookings), one disconnection, one reconnect,
and the settlements required to force the remote booking ahead of replay.
Removing either Client, either booking, the disconnection, or the ordering
settlement removes the failure. Payloads are canonical identifiers and the
smallest failing numeric state (`1 -> 0 -> -1`).

### Current artifact

No SF-01 artifact is retained. The current pinned core stalls at an earlier
Settlement, so a newly generated run would not be evidence of this finding.
The retained Scenario source remains the canonical reproducer.

### Remaining uncertainty

- The intended product contract for application events that become invalid only
  after rebase needs an explicit decision: rejection, compensation, quarantine,
  or terminal Store failure.
- Process and browser host protocols do not carry the nested Store shutdown
  cause, preventing a cross-profile signature match.
- In the real sync backend, the offline event reaches global position `e3`
  before participants stall. Whether that event should be accepted upstream
  before successful local replay is a protocol-policy question requiring core
  ownership clarification.

## SF-02: exactly 400 pending Events stall after rebase over one remote Event

### Failure summary

Client A commits 400 Events while disconnected. Client B confirms one Event.
After A reconnects and rebases, synchronization advances only through A's first
301 Events, then stops permanently with 99 pending Events. No runtime error is
reported and no further backend, upstream, or participant head progress occurs.

Classification: **LiveStore sync-engine liveness/correctness failure**. The
runner reports a settlement timeout, but a doubled observation window proves
that the engine state itself is stationary. A nearby passing count and a
single-Client control distinguish the stall from ordinary runner overhead.

### Expected versus actual behavior

- Expected: all 400 locally committed Events are eventually confirmed after the
  backend route returns; both Clients converge at global head `e401` with zero
  pending Events.
- Actual: backend and Client B stop at `e302`; Client A remains at local head
  `e401r2`, upstream head `e302`, with exactly 99 pending Events. The final 99
  Events never enter confirmed history.

### Stable failure signature and reproducibility

The 60-second signature reproduced in **3/3** consecutive runs:

```text
terminal=settlement-timeout
annotation=reconcile-pending-tail
instruction=settle-pending-tail
client-a=local e401r2, upstream e302, pending 99
client-b=local e302, upstream e302, pending 0
backend=e302, events 302
```

A separate 120-second run ended with the exact same heads and pending count.
The last minute contained repeated identical settlement observations, so this
is not merely a run that completed between the original timeout and a slightly
larger bound.

### Exact reproduction

Profile `in-process + mock`, seed `3001`:

```sh
SCENARIO_PENDING_COUNT=400 \
SCENARIO_SETTLEMENT_TIMEOUT_MS=60000 \
GITHUB_SHA=816c2a1d563ecfe15c200ad39f2ea0101914ecee \
  pnpm --dir tests/scenarios scenario:run \
  --profile in-process \
  --scenario pending-tail-recovery \
  --output artifacts/correctness-pending-tail-400-in-process-r1.json
```

LiveStore revision:
`1ce3d5484c7822f06ed054ddafbc14398cabc325`.

### Minimized scenario

`tests/scenarios/src/corpus/scenarios/retained/findings/pending-tail-recovery.ts`

Current reduction evidence:

- 399 pending Events plus one confirmed remote Event passes.
- 400 pending Events plus one confirmed remote Event stalls.
- One Client with 400 pending Events and no remote history passes, so Client B,
  its one Event, and the resulting rebase are essential.
- The topology has one session per Client, one disconnect, one reconnect, one
  remote action, and no sleeps or parallel operations.
- Payloads are small unique todo identifiers and strings. The failure depends
  on Event count and ordering, not payload size.

### Current artifact

No SF-02 artifact is retained. The current pinned core stalls at an earlier
Settlement, so a newly generated run would not be evidence of the reduced
400-Event finding. The retained Scenario source remains the canonical
reproducer.

### Remaining uncertainty

- The exact internal loss point is not exposed by the current artifact. Backend
  observations advance `e1 -> e101 -> e302`; inspecting core code suggests an
  interaction between 100-Event session-to-Leader batches, pull-triggered
  rebase, queue reconciliation, and backend-push restart, but that is a working
  hypothesis rather than proven causality.
- The minimal Event count may depend on `leaderPushBatchSize`; the current runner
  does not expose Store parameters as a Scenario dimension.
- Process promotion passes through real `sync-cf`, so the observed stall is
  currently specific to the mock-backend delivery/reconciliation schedule.
  Browser promotion remains outstanding.

## SF-03: two active writers can rematerialize a unique Event twice

### Failure summary

Two connected Clients receive a deterministic 426-Event action sequence. Every
application action has a globally unique todo ID, but Client 2 shuts down while
pulling because SQLite reports `UNIQUE constraint failed: todos.id`. Backend
artifacts also contain only unique IDs, ruling out duplicate generated output or
duplicate backend rows as the direct cause.

Classification: **LiveStore sync-engine materialization/correctness failure**.
An Event already represented in Client 2's materialized State is presented to
the materializer as another insert during reconciliation.

### Expected versus actual behavior

- Expected: each of the 426 unique Events materializes once per Client and both
  Clients converge with 426 rows.
- Actual: Client 2's Store shuts down during pull with a nested SQLite unique-key
  failure. The runner terminates with `participant-runtime-failure` before final
  snapshots can be collected.

### Stable failure signature and reproducibility

The minimized signature reproduced in **3/3** consecutive runs:

```text
terminal=participant-runtime-failure
participant=client-2/session-2
annotation=distribute-writes
instruction=settle-many-writers
cause=UNIQUE constraint failed: todos.id
requested-action-ids=426 unique / 426 total
```

Backend progress before shutdown varied with scheduling (346 or 366 Events),
but every captured backend ID remained unique. The stable failure signature is
therefore the participant, pull/materialization stage, and SQLite cause—not an
incidental backend head or trace-record count.

### Exact reproduction

Profile `in-process + mock`, seed `3004`:

```sh
SCENARIO_WRITER_COUNT=2 \
SCENARIO_EVENT_COUNT=426 \
GITHUB_SHA=816c2a1d563ecfe15c200ad39f2ea0101914ecee \
  pnpm --dir tests/scenarios scenario:run \
  --profile in-process \
  --scenario many-writer-convergence \
  --output artifacts/correctness-many-writer-2x426-in-process-r1.json
```

LiveStore revision:
`1ce3d5484c7822f06ed054ddafbc14398cabc325`.

### Minimized scenario

`tests/scenarios/src/corpus/scenarios/retained/findings/many-writer-convergence.ts`

Current reduction evidence:

- Eight Clients and 512 Events fails with the same SQLite signature.
- Two Clients and 512 Events fails, removing six Clients.
- Two Clients with 425 Events passes; 426 fails.
- All 426 application IDs and all backend IDs observed before failure are
  unique, so the generator is not producing conflicting inserts.
- The Scenario has one generated action sequence and one settlement. It has no faults,
  disconnects, restarts, sleeps, or explicit parallel group.

### Canonical artifact

- `tests/scenarios/artifacts/sf-03-many-writer-426.json.gz`

This is the minimized two-Client, 426-Event in-process failure. Larger topology
and passing-boundary probes remain reduction results rather than viewer entries.

### Remaining uncertainty

- The artifact identifies the failing Store and materialization operation but
  does not include the exact Event ID being inserted twice. Core tracing or an
  inspector captured immediately before shutdown is needed to identify it.
- The 426 boundary is seed/distribution specific. Other seeds may move
  the boundary by changing which Client originates each sequential action.
- Process promotion shuts the Store down during the action sequence, but the host
  protocol reports only
  `host-request-rejected`/`UnknownError` and loses the nested SQLite cause. This
  corroborates a real-backend failure without proving an identical signature.
  Browser promotion likewise observes Store shutdown during the action sequence as a
  `host-transport-failure`, without the SQLite cause.

## SF-04: encoded transport-size boundary (reclassified)

The historical 899,643-byte ASCII payload exceeds an intentional sync-cf
transport limit. It is not evidence of a supported-size recovery regression.

At core revisions `ba85edffd44170139e1072a770045e09a1572abe` and
`ebf19cf50d9ea9121b701b5f6e7946ef58eaaac6`,
`packages/@livestore/sync-cf/src/common/constants.ts` sets
`MAX_TRANSPORT_PAYLOAD_BYTES` to **900,000 bytes**, with a safety margin below
roughly 1 MB. The limit covers the encoded message, including metadata, rather
than just the application string. `splitArrayBySize` splits batches between
Events and rejects a single oversized item with `OversizeChunkItemError`.

Using the scenario's Event, a 21-character backend ID, and the provider's
ISO timestamp metadata, the actual `SyncMessage.PullResponse` encoder produces:

| Application string | Encoded response | Size check |
| --- | --- | --- |
| 899,642 bytes | 900,000 bytes | Accepted |
| 899,643 bytes | 900,001 bytes | Rejected |
| 524,288 bytes (512 KiB) | 524,646 bytes | Accepted |

This explains the historical one-byte boundary. The mock backend does not
impose the sync-cf transport cap. Push and pull envelopes differ in size;
acceptance of the local commit or push does not imply that a pull response fits.
The provider persists pushed Events before preparing its broadcast response.

The retained `large-payload-recovery` scenario is now an example with a default
512 KiB string. It still commits offline, reconnects, and checks that pending
Events resolve and both Clients converge. Its source is
[`large-payload-recovery.scenario.ts`](./src/corpus/scenarios/retained/examples/large-payload-recovery.scenario.ts).
The previous boundary remains reproducible explicitly:

```sh
pnpm --dir tests/scenarios scenario:run \
  --profile process \
  --scenario large-payload-recovery \
  --set payload_bytes=899643 \
  --output artifacts/large-payload-boundary.json
```

The historical process/browser runs surfaced an empty `UnknownError` instead
of a useful size diagnostic. That remains a separate error-reporting concern;
reducing the recovery payload does not fix oversized-event rejection or its
diagnostics. Historical artifacts should retain their original payload sizes
and outcomes.

## Runner finding RF-001: local sync-cf observations were not globally ordered

The local backend observer flattened provider pull pages in delivery order. A
later observation could therefore contain `e302` before `e101` even though each
Event and global position was correct. The confirmed-prefix oracle correctly
treated array order as semantic and produced a false failure after SF-02
otherwise converged through real `sync-cf`.

Classification: **scenario-runner observation bug**, not a LiveStore failure.

The observer now sorts the flattened provider result by global `seqNum` before
constructing backend evidence. A focused unit regression passes, the complete
Eventlog oracle suite passes, and rerunning the 400-Event process Scenario now
passes all oracles with both Clients at `e401` and zero pending Events.

The before/after comparison was useful during diagnosis but is not retained in
the minimal viewer corpus.

## Negative results and evidence gaps

| Probe                                                 | Result                                                                    | Classification                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| Full Scenario suite on compatible core revision       | 56/56 passed                                                              | Baseline negative result              |
| Viewer production build                               | Passed                                                                    | Baseline negative result              |
| Full suite on upstream `main` `6fff977...`            | 17 failures from absent `isConnected` seam                                | Version/harness mismatch              |
| Process-host SF-01 replay                             | Deterministic unresolved settlement, underlying cause absent              | Diagnostic evidence gap               |
| Browser-host SF-01 replay                             | Deterministic interrupted runtime, underlying cause absent                | Diagnostic evidence gap               |
| Reconnect flapping, one pending plus one remote Event | Passed; 3 route flaps, 172 records                                        | Negative result                       |
| One-MiB offline Event payload                         | Passed commit, reconnect, sync, and remote materialization                | Passing payload threshold             |
| Pending rebase at 399 Events                          | Passed in about 29 seconds                                                | Passing count immediately below SF-02 |
| One Client with 400 pending Events                    | Passed; 911 records                                                       | Passing topology reduction control    |
| Two writers with 425 unique Events                    | Passed; 970 records                                                       | Passing count immediately below SF-03 |
| Backend outage with two local writers                 | Passed under mock and process/local-sync-cf                               | Recovery negative result              |
| Two browser sessions sharing one Leader               | Passed Leader turnover, session restart, full Client restart, OPFS reopen | Lifecycle negative result             |
| SF-02 through process/local-sync-cf                   | Passed at e401 after RF-001 fix                                           | Mock-schedule-specific boundary       |

## Untested dimensions blocked by runner capabilities

- **Scripted delivery schedules:** the mock Scenario backend cannot yet delay,
  duplicate, truncate, replay, or reorder selected pull/push batches, nor inject
  stale/reset cursors. Testing these by sleeping would not identify the protocol
  boundary crossed, so no product conclusion is recorded.
- **Process restart with persisted pending State:** the model exposes session and
  Client restart only through the browser host. Browser session/Client/Leader
  lifecycle passes, but killing and reopening an isolated process at a named
  acknowledgement/rebase boundary is not currently expressible.
- **Leader batch parameters:** Store `leaderPushBatchSize` and Leader sync batch
  sizes are not Scenario dimensions. SF-02 and SF-03 have sharp count
  boundaries, but moving those boundaries with batch configuration remains an
  evidence gap.
- **Rematerialization equivalence:** the runner can inspect live State and ordered
  Eventlogs but cannot rebuild a fresh State database from confirmed history and
  compare it with the live database.
- **Precise resource telemetry:** artifacts retain full logical evidence but do
  not record heap, SQLite file, queue, frame, or encoded payload sizes. Payload
  dimensions describe application data; SF-04's encoded sizes were measured
  separately with the provider schema.

These are runner limitations, not negative LiveStore results.

## Validation status

- `pnpm --dir tests/scenarios exec vitest run --maxWorkers=1`: 18 files,
  65/65 tests passed. The default parallel run passed 64/65; its sole
  process-profile timeout passed immediately in isolation and in the serial
  suite.
- `pnpm --dir tests/scenarios viewer:build`: passed.
- `pnpm --dir tests/scenarios viewer:parity`: 18/18 browser tests passed.
- Targeted `oxfmt --check` for all campaign source and this ledger: passed.
- OXLint: passed.
- `git diff --check`: passed.
- `tsc -b tests/scenarios/tsconfig.json --pretty false`: passed.
- The repository-wide generated-file check remains blocked by the pinned
  effect-utils Genie version rejecting existing CI retry-helper steps that lack
  its newer preparation step. This predates and is unrelated to the campaign.
