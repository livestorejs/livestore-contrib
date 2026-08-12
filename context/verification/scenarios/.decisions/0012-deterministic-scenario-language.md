# 0012 — Author deterministic Scenarios as typed pipelines

Status: accepted (design interview, 2026-08-09); implemented

## Context

The normalized Scenario plan is precise and portable, but authoring that raw
AST exposes runner bookkeeping and repeats facts derivable from source. A
data-only custom language made common cases concise, but required a full
parser/compiler, separate helper registration for loops and branches, and
custom editor support. Authors need one readable form without moving execution
semantics or application behavior into prose.

## Decision

Author committed and local cases as trusted `.scenario.ts` modules using an
immutable `Scenario.start({...}).pipe(...)` API. The filename stem is the
Scenario ID. Source selects one typed Application explicitly, may add a
description and seed, declares every initial Client and session, and provides
one ordered pipeline of instructions plus optional final expectations. Aliases
are ordinary lexical constants over explicit session values and never appear in
the normalized instruction stream.

Application action methods and their inputs are inferred from the registered
Application definition. TypeScript supplies syntax, comments, imports, loops,
branches, structured values, and editor tooling. Reusable composition is an
ordinary typed function. One-off logic stays in the Scenario module; shared
logic is imported from a normal module. There is no YAML parser, custom grammar,
helper registry, companion-file convention, or runner-facing callback.

Evaluating source produces an immutable `ScenarioPlan`. Before any participant
starts, normalization validates topology and lifecycle references,
Application/action ownership and input schemas, State inspectors, parameters,
durations, sequence bounds, generated JSON, and expectations. It expands
repeated or generated actions, derives Store identity and capabilities, assigns
instruction/operation/oracle IDs, and emits the serializable `ScenarioAst`
already consumed by the runner and artifacts. Profile/backend selection, Store
ID, capabilities, tags, format versions, and runner IDs remain unauthored.

When no final `expect(...)` operation is authored, normalize pending-resolution
and exact ordered Eventlog-convergence oracles for every session still running
after the last instruction. An explicit expectation list replaces both
defaults and may name a session or lexical alias. Explicit `settle(...)` remains
only an intermediate convergence barrier when later instructions need a stable
point; operational stabilization bounds remain run configuration.

The retained registry uses static imports. `--scenario-file` dynamically
imports only the exact file explicitly selected by the operator. Scenario
modules are executable and therefore trusted repository or local code; this is
a wider authoring trust boundary than data-only source. The execution boundary
does not widen: the runner receives only validated data.

## Consequences

Scenarios retain a plan-shaped, scan-friendly pipeline while gaining standard
TypeScript highlighting, completion, formatting, refactoring, and general
programmability. Renaming a file intentionally changes Scenario identity.
Adding explicit expectations requires spelling every desired oracle, avoiding
hidden default-plus-override behavior.

The custom YAML compiler, helper registry, companion loader, and YAML dependency
are removed. Source evaluation can perform arbitrary ambient Node work, so
untrusted Scenario modules must not be loaded. Determinism for repository
Scenarios is maintained by convention, review, keyed random utilities, and
normalization tests rather than by a restricted parser sandbox.
