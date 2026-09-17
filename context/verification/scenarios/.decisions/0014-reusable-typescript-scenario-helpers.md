# 0014 — Resolve reusable TypeScript helpers at the Scenario source seam

Status: superseded by decision 0012 (2026-08-09)

## Context

The former YAML design needed a way to express finite action sets requiring
loops, branches, structured values, participant selection, or seeded choices
without placing generation policy on an Application or in the runner.

## Decision

The original decision introduced a registered shared helper catalogue and
optional same-name `.helpers.ts` companions expanded by the YAML compiler.
Decision 0012 supersedes that mechanism by making each Scenario a trusted
TypeScript module. Reusable helpers are now ordinary typed functions imported
directly by Scenario source. One-off logic lives directly in the Scenario
module; no registration or companion convention remains.

The preserved execution boundary is the important part of this decision:
helpers produce finite Scenario operations during authoring, normalization
expands them into validated serializable instructions, and no function or
module reference crosses into the runner, participant hosts, or artifact.

## Consequences

Authors can add general computation without editing the runner whenever it
composes existing operations. A genuinely new runtime capability still
requires a normalized instruction, capability contract, runner implementation,
and evidence semantics. Application definitions remain free of Scenario
generation policy.
