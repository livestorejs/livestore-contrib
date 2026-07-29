# 0001 — Compose in-process, process, and browser profiles

Status: accepted (existing `tests/scenarios` profile and conformance evidence,
2026-07-29)

## Context

The core contract requires capability-described, production-shaped participant
hosts without selecting a mechanism. The imported realization already has one
portable host API and corpus spanning three useful placement boundaries.

## Decision

Keep three participant profiles: in-process, isolated Node process, and
persistent Chromium. Use core `makeMockSyncBackend` for controlled in-process
evidence and a real local `sync-cf` Worker/Durable Object for process and browser
evidence. Model backend unavailability at a Scenario-owned participant-route
proxy rather than adding Scenario controls to the sync engine.

Every profile joins the shared capability-parameterized conformance suite.
Unsupported combinations and stronger faults remain unavailable capabilities.

## Consequences

The portable AST and corpus stay independent of execution placement. Browser
and process results remain evidence only for their selected profile. Exact
delivery replay, hard socket destruction, backend process death, and exact
Event lineage are not implied by this baseline.
