# 0005 — Separate causal flow from calibrated elapsed time

Status: accepted (causal/time viewer projections in
`tests/scenarios`, 2026-08-01)

## Context

Runner receipt order can serialize independent observations, while a semantic
flow view can hide operational delay. Process and browser participants also
have monotonic clocks with different origins. Contributors need both supported
causal structure and elapsed-time evidence without turning timestamps into
LiveStore ordering semantics.

## Decision

Retain runner receipt index, participant-local sequence, logical time, wall
time, participant-local monotonic time, coordinator receipt time, calibrated
Scenario-time intervals, correlation, capture membership, and explicit
`causedBy` edges as distinct trace facts.

Only explicit retained edges and participant-local sequence support causal
order. Correlation associates records; receipt order, timestamp order, equal
Event fields, and observation-capture membership create no causal edge.
Same-process observations use the shared controller monotonic clock. Remote
observations retain the complete controller request round trip as a calibrated
uncertainty interval; overlapping intervals remain temporally unordered.

Keep causal-flow and elapsed-time viewer projections over the same immutable
trace. Flow may aggregate records and align equivalent semantic stages without
claiming simultaneity. Elapsed-time layout may expose delay and uncertainty
without claiming causation. Raw records and their receipt-index cursor remain
available in both projections.

## Consequences

Logical time controls only runner-owned plan structure, and wall time is the
only basis available for future portable performance claims. Neither clock nor
projection participates in Sync. Timing that contradicts an explicit causal
edge beyond its uncertainty indicates instrumentation or calibration trouble.
Exact transition latency remains unavailable where either boundary is merely
sampled.
