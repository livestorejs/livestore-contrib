# LiveStore Scenario Red-Team Plan

This plan turns the Scenario runner into a repeatable search for correctness,
durability, availability, and recovery failures. Every discovered failure must
end as a deterministic artifact and then as the smallest Scenario that retains
the same failure signature.

The first proven seed is `concurrent-hotel-booking`. It realizes the invalid
rebase described by the
[command replay RFC](https://github.com/livestorejs/livestore/blob/main/contributor-docs/rfcs/0002-command-replay.md):

1. Clients A and B confirm hotel-room inventory at `1`.
2. A disconnects; A and B each decrement their local `1` to `0`.
3. B's decrement is confirmed upstream.
4. A reconnects and rebases its pending decrement over B's confirmed event.
5. Replaying A's decrement attempts `0` to `-1`; SQLite rejects it and the
   Store shuts down.

The fixture uses a SQLite trigger equivalent to `CHECK (available >= 0)` because
the current `State.SQLite.table` DSL does not expose CHECK constraints. The
failure is therefore database-enforced, not application validation. The leader
logs `MaterializeError`; the Store shutdown boundary currently reports a nested
SQLite failure as `UnknownError`. Both facts are retained rather than normalized.

The controlled in-process run fails during A's reconnect while the backend still
contains only the initializer and B's decrement, proving that the rejected
operation is A's pending replay. A validation run through the isolated process
profile and real local `sync-cf` also reproduced the constraint failure, but the
backend accepted A's Event at the next global position before both Clients
stalled. Because the process host does not yet carry Store shutdown evidence,
that run terminated as `settlement-timeout`. Treat this profile difference as a
lead to reproduce and reduce, not yet as a generalized protocol conclusion.

## Failure contract

A run is interesting when it violates at least one of these properties:

- **Safety:** confirmed history is not append-only, Clients disagree on ordered
  Events or State, materialized State violates an application invariant, or a
  rematerialized database differs from the live database.
- **Durability:** a confirmed or acknowledged local change disappears across
  reconciliation, process exit, session restart, Client restart, or storage
  reopen.
- **Liveness:** pending work never resolves, heads stop advancing, recovery does
  not complete within a bound, or a participant deadlocks or spins.
- **Availability:** a valid operation, transient fault, or recoverable conflict
  permanently shuts down a Store or makes it impossible to reopen without
  deleting local data.
- **Resource safety:** event, queue, batch, memory, file, or SQLite limits lead
  to corruption, unbounded growth, an untyped crash, or loss of progress.
- **Diagnostic integrity:** a failure is silent, attributed to the wrong
  operation, or crosses the host boundary without a stable category and useful
  cause.

Each failure gets a signature containing the terminal category, normalized
cause, failing participant, last confirmed and local heads, pending count, and
the first trace record that proves the violation. Reduction and regression
tests compare this signature rather than incidental timing or stack frames.

## Search dimensions

Explore dimensions independently first, then combine only pairs and triples
that have a plausible interaction. This keeps failures explainable and makes
reduction tractable.

| Dimension                | High-value families                                                                                                                                                                               | Primary properties                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Reconciliation order     | stale non-negative counters; delete versus dependent create; competing unique claims; move versus delete; multi-event command split by remote history; non-commutative updates                    | safety, availability                       |
| Event shape and volume   | one very large Event; geometric pending counts; mixed tiny/large Events; large transactions; boundary payloads around discovered transport, queue, SQLite, and binding limits                     | resource safety, durability, liveness      |
| Connectivity             | short repeated blackouts; reconnect during pull, materialization, or push; asymmetric participant route; backend outage around confirmation; flap immediately after acknowledgement               | liveness, durability, diagnostic integrity |
| Delivery protocol        | delayed, duplicated, truncated, or replayed batches; cursor reset; stale cursor; head regression; reconnect between batch receipt and cursor persistence                                          | safety, durability                         |
| Lifecycle                | session/Client/process restart with pending Events; Leader turnover during reconciliation; late session join; close while push is in flight; reopen after runtime failure                         | durability, availability                   |
| Topology                 | many Clients with one writer; many concurrent writers; many sessions on one Client; dynamic join during backlog; isolated subgroups that reconnect in different orders                            | safety, liveness                           |
| Materialization          | CHECK, UNIQUE, NOT NULL, and foreign-key conflicts; state-dependent materializers; multi-statement partial failure; deterministic replay; schema-version skew and unknown Events                  | safety, availability                       |
| Scheduling               | parallel actions at every host boundary; fault insertion before request, after dispatch, before acknowledgement, and after acknowledgement; same logical Scenario under different valid schedules | safety, diagnostic integrity               |
| Persistence and recovery | restart after local commit, remote pull, rollback, replay, or confirmation; rematerialize from the Eventlog; reopen with a large pending tail                                                     | durability, availability                   |
| Time and identifiers     | equal timestamps, clock jumps, generated-ID collision, deterministic seed replay, random/time-dependent materializer output                                                                       | safety, determinism                        |

Do not guess a product limit. For size and count failures, start with geometric
growth (`1, 2, 4, ...`) to find a boundary, binary-search the smallest failing
value, then test just below, at, and just above it.

## Campaign loop

1. Generate a valid Scenario from an application model and a deterministic seed.
2. Run fast in-process exploration first, retaining only the failure signature
   and compact run summary for passes.
3. Re-run interesting seeds enough times to distinguish deterministic failures
   from schedule-sensitive ones.
4. Promote stable failures through local `sync-cf`, isolated process, and browser
   profiles when those profiles provide the required controls and evidence.
5. Save the complete first-failure artifact and component versions.
6. Reduce the Scenario while requiring the same failure signature.
7. Commit the reduced Scenario as a named corpus case and a regression test.

An overnight job should spend most of its budget on in-process generated cases,
reserve a smaller budget for real-backend confirmation, and use the browser only
for promoted failures or browser-specific lifecycle hypotheses. A seed queue,
not wall-clock sleeps, should decide promotion.

## Reduction

Reduction is part of discovery, not later cleanup. Use hierarchical delta
debugging in this order:

1. Remove whole phases, then contiguous step ranges, then individual steps.
2. Remove Clients and sessions, preserving references and required settlement.
3. Remove generated actions and Events; shrink action-sequence count with binary search.
4. Simplify parallel groups to sequential pairs and remove unrelated faults.
5. Shrink payloads, strings, identifiers, numeric values, and timeout/fault
   durations toward canonical minima.
6. Replace generated sequences with their surviving explicit actions when that improves the reduced explanation.
7. Normalize names and seed while retaining the failure signature.

A deterministic result is minimal when no remaining phase, participant,
operation, fault, or input field can be removed or simplified while reproducing
the signature in five consecutive runs. A schedule-sensitive result records its
reproduction rate and is minimized against a fixed attempt budget; it is not
misrepresented as deterministic.

The reducer must understand dependencies: initialization before use, Client
creation before targeting, disconnect before reconnect, fault injection before
removal, and terminal Settlement required by snapshot oracles. Invalid candidate
Scenarios are discarded rather than counted as successful reductions.

## Prioritized first campaign

1. **Invariant-rebase matrix:** derive CHECK, UNIQUE, foreign-key, and NOT NULL
   cases from the concurrent-decrement seed. Vary which Client is isolated and
   reconnect order. This establishes materialization-failure classification.
2. **Pending-tail boundary:** create a disconnected writer, grow its pending
   sequence geometrically, confirm competing remote history, reconnect, and
   measure resolution, memory, and failure category.
3. **Reconnect flapping:** alternate connectivity at reconciliation boundaries,
   first with one pending Event and then with a reduced backlog. Look for Event
   loss, duplicate confirmation, stuck pending state, and repeated rollback.
4. **Restart windows:** restart the session, Client, or process immediately after
   local acknowledgement, remote observation, and reconnect acknowledgement.
5. **Protocol disturbance:** add mock-backend controls for delayed, duplicated,
   replayed, and truncated pull batches plus cursor/head anomalies, then run the
   same corpus and oracles.
6. **Rematerialization equivalence:** after successful convergence and after
   recovery, rebuild State solely from the Eventlog and compare every inspector.
7. **Topology expansion:** promote surviving cases to many writers, multi-session
   browser Clients, dynamic joins, and Leader turnover.

## Runner work needed

- Implement stable failure signatures and an `expected-failure` assertion so a
  known reproducer remains green without treating the product failure as a pass.
- Implement dependency-aware `ddmin` over normalized Scenario ASTs and expanded
  generated action sequences (LSC.VER.SCEN-DQ1).
- Carry Store shutdown/runtime failure evidence through process and browser hosts;
  in-process capture is now available.
- Add barrier-addressable fault points. Sleeps alone cannot prove which protocol
  boundary a fault crossed.
- Add scripted mock-backend delivery faults and advertise each as an explicit
  capability.
- Add invariant, monotonic-head, rematerialization-equivalence, bounded-progress,
  and resource-budget oracles.
- Record compact resource samples and exact component/configuration versions for
  promoted failures.
- Add a campaign CLI that accepts seed range, time budget, profile budget,
  parallelism, promotion policy, and artifact retention policy.

The first implementation milestone is complete when the four invariant-rebase
families can be generated, classified, reduced automatically, replayed through
the artifact viewer, and promoted across every compatible execution profile.
