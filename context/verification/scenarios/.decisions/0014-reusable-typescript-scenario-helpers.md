# 0014 — Resolve reusable TypeScript helpers at the Scenario source seam

Status: accepted (design interview, 2026-08-09)

## Context

YAML keeps Scenario source readable, but some finite action sets need ordinary
TypeScript computation: loops, branches, structured values, participant
selection, or seeded choices. Registering that code on an Application makes
authoring policy part of the runtime Application interface and contradicts the
locality established by decision 0010. Requiring runner edits for every new
workload pattern would likewise move compile-time variation across the
execution seam.

Some helpers are reusable across the corpus. Others explain one Scenario only
and should remain beside it without becoming global vocabulary.

## Decision

Resolve trusted TypeScript helpers while loading Scenario source, before the
normalized plan reaches the runner. Application definitions continue to own
only real Application actions, inspectors, Schema, and materialization. The
runner and participant hosts receive only the expanded, validated,
serializable Scenario plan; no helper callback or module reference crosses the
execution seam.

Provide two helper sources:

1. a shared helper catalogue available to every Scenario source; and
2. an optional same-directory companion named from the Scenario stem, so
   `example.scenario.yaml` uses `example.helpers.ts`.

The retained corpus and committed test fixtures attach companion modules with
static imports. Explicit local `--scenario-file` loading may discover the exact
companion filename through an isolated asynchronous Node loader. YAML never
contains an arbitrary module path. Shared and companion helper names compose
without precedence; a duplicate is an error.

A helper accepts Schema-validated JSON input and deterministic compiler
context, may use ordinary synchronous TypeScript computation, and returns a
finite declarative fragment drawn from the existing Scenario instruction
vocabulary. The compiler assigns identities, resolves participants, derives
capabilities, validates Application actions and inputs, bounds expansion, and
embeds every concrete instruction in the normalized plan. Helpers receive no
filesystem, network, environment, wall-clock, runner, participant-host, or
LiveStore capability. Keyed random choices remain derived from the Scenario
seed and stable compiler identity.

Use Effect `Duration` behind the concise YAML duration syntax and Effect
`Clock` for controller elapsed-time measurement. Timing retained in the plan
and trace remains explicit serializable data. Opaque or potentially infinite
Effect `Schedule` values are not part of the helper result or normalized plan;
future schedule policies must first receive finite, inspectable Scenario
semantics.

## Consequences

Authors can add or reuse a helper without editing the runner whenever its
result is a composition of existing instructions. A genuinely new runtime
capability still requires a normalized instruction, host capability, runner
implementation, and evidence semantics.

Application modules no longer enter CLI, participant-host, or viewer bundles
with Scenario generation policy. Shared helpers earn reuse across Scenario
sources, while one-off code has locality beside its YAML. Compilation remains
deterministic and inspectable even though trusted TypeScript performs the
authoring expansion.
