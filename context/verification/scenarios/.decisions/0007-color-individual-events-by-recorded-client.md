# 0007 — Color individual Events by their recorded producer Client

Status: accepted (viewer provenance design, 2026-08-01)

## Context

The viewer renders the same observed Event facts in backend and Client logs and
on backend, Leader, and session timeline lanes. Coloring an Event by the
component that happened to observe it would make the color change as the Event
propagates. Coloring it by its current position would likewise change during a
rebase. Each observed Event already retains the producing `clientId` and
`sessionId` as recorded origin facts, while `eventRef` remains sampled
correlation rather than exact lineage.

## Decision

Color every individually rendered Event by `origin.clientId`, using the same
Client-to-color mapping as the Client's timeline tracks. Keep that origin color
through pending, rebase, confirmation, and propagation presentations because
none of those position or disposition changes selects the color.

Do not assign one producer color to an aggregate containing multiple Events;
keep the existing neutral aggregate treatment. Preserve pending, selected, and
future states as orthogonal visual treatments. Session origin remains available
for inspection and a possible later secondary encoding, but does not determine
the initial color implementation.

This is a visualization of recorded producer metadata, not an assertion that
run-local `eventRef` correlation proves exact Event identity across samples.

## Consequences

An Event has the same Client color in every individual viewer presentation even
when it is shown on another Client's or the backend's lane. The shared palette
must be derived independently of the observing component. Aggregate density
views remain legible without inventing a dominant producer, and adding a future
session-level encoding does not require changing the artifact schema.
