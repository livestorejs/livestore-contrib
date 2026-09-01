# 0011 — Use one flat Scenario instruction stream

Status: accepted (phase-removal refactor, 2026-08-08); terminal stabilization
consequence refined by decision 0012

## Context

Scenario phases grouped ordered steps and decorated traces, but crossing a phase
boundary changed no execution behavior. Mandatory nesting made Scenario source
harder to scan and suggested a lifecycle that the runner did not implement.
The actual behavioral structure already came from instruction order, explicit
parallel groups, Settlement, and oracles.

## Decision

Represent a Scenario as initial topology, one ordered instruction stream, and
oracles. Retain optional narrative structure as zero-effect `annotation`
instructions. When the runner reaches an annotation it records
`annotation.reached`; an annotation is never an operation, grouping construct,
or execution boundary.

The runner consumes only the normalized, serializable Scenario plan. Future
authoring syntaxes may compile that plan in memory and pass it directly to the
runner, but the runner does not interpret authoring syntax. Repetition derives
keyed choices from the Scenario seed, action-sequence ID, iteration, and choice
key without a grouping ID.

Scenario version 3, trace version 5, and artifact version 6 are the only
supported formats. There is no compatibility bridge or hidden generated phase.

## Consequences

Instruction IDs provide progress and failure context. Logical time advances by
instruction, terminal Settlement validation uses the final executable
instruction, and annotations may follow it without weakening its evidence.
Artifacts retain both the exact executable plan and the annotations actually
reached. The corpus, projections, viewer, and retained references move together
to the current format.
