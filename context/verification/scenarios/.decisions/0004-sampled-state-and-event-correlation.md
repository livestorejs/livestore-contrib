# 0004 — Keep sampled State and Event correlation within their evidence limits

Status: accepted (trace protocol v3, all-profile capability contract, and
projection/oracle tests in `tests/scenarios`, 2026-08-01)

## Context

The replay viewer needs to show how backend, Leader, and session facts appeared
throughout a run. Those facts are sampled across process and browser boundaries,
not captured as one atomic distributed State. Current Event observations expose
encoded fields and changing Eventlog positions, but no profile can prove that
one observed occurrence is the same Event through pending, rebase,
confirmation, and propagation transitions.

The implementation assigns `eventRef` values from a run-local
fingerprint/occurrence registry. That label makes repeated observations easier
to navigate, but equal fields and occurrence counts are not an instrumented
lineage mapping.

## Decision

Scrubbing reduces the complete receipt-ordered trace prefix to accumulated,
component-scoped Observed State. An observation capture groups samples from one
collection pass without claiming simultaneity or an atomic global snapshot.

Keep `eventRef` as diagnostic run-local correlation only. Every current profile
withholds the `event-lineage` capability. Oracles and causal projections must
not treat `eventRef`, Event fields, Eventlog positions, capture membership, or
timing as exact identity evidence. Participant hosts and backend observers read
actual LiveStore surfaces; runner instructions never synthesize product State.

An exact lineage capability may be advertised only if a profile retains
explicit transition mappings over actual encoded Event facts. Scenario needs
alone do not justify adding an Event field or hot-path observer to core.

## Consequences

Viewer projections remain honest but cannot draw exact receive/apply lineage.
Eventlog oracles compare retained facts and positions within their declared
sampling boundary. Checkpoints may accelerate replay only as derived caches;
the trace prefix remains authoritative.
