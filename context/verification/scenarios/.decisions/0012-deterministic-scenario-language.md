# 0012 — Author deterministic Scenarios as instructions

Status: accepted (design interview, 2026-08-08); implementation pending

## Context

The normalized Scenario plan is precise and portable, but authoring that plan
as TypeScript exposes runner bookkeeping, repeats facts derivable from source,
and makes a distributed story harder to scan. Terminal Settlement also mixes a
Scenario's convergence intent with profile-sensitive safety timeouts. Authors
need one deterministic language that remains readable without moving execution
semantics or application behavior into prose.

## Decision

Author committed and local cases as `.scenario` files. The filename stem is the
Scenario ID. Source selects one registered Application explicitly, may add an
optional description, declares every Client and session, and then gives one
flat ordered body of instructions, compile-time participant aliases, and
optional final expectations. Participant references are always fully qualified
as `client/session`; Clients start connected unless explicitly declared
disconnected. Aliases resolve top-to-bottom and cannot refer to future dynamic
topology.

The deterministic compiler parses and validates the complete source before a
participant starts, expands repetition and keyed random choices, derives Store
identity and host capabilities, assigns internal instruction, operation, and
oracle IDs, and produces the normalized serializable Scenario plan consumed by
the existing runner. Source contains no profile/backend selection, Store ID,
capability list, tags, language-version declaration, or authored runner IDs.
Application actions and inspectors retain their exact registered names and
typed boundaries. An annotation remains an explicit zero-effect `note`.

When no final `expect` block is authored, compile pending-resolution and exact
ordered Eventlog-convergence oracles for every session still running after the
last instruction. One or more explicit final `expect <participants>:` blocks
replace those defaults for the whole Scenario; each body line maps to one
oracle, while Application-specific State expectations remain explicit. Local
operation-history expectations stay inside their `concurrently` or repeated
action block.

Final snapshot expectations establish terminal stabilization for their
participants before evaluation. Authors do not write a terminal Settlement.
Explicit `settle <participants>` remains only as an intermediate convergence
barrier when later instructions depend on a stable point. Settlement and
terminal-stabilization safety bounds belong to run configuration rather than
Scenario source, so one Scenario can run under profiles with different
operational costs. Stabilization never reconnects a disconnected Client
implicitly.

This decision refines decision 0011's compiler boundary and supersedes decision
0006 only where it requires an authored terminal Settlement and embeds its
timeout in Scenario behavior. Operation, acknowledgement, observation,
Recovery, stabilization, and oracle verdicts remain distinct evidence.

## Consequences

Scenario source reads as the behavior being exercised while normalized
artifacts remain exact and replayable. Renaming a file intentionally changes
Scenario identity. Adding an explicit expectation contract requires spelling
every desired oracle, avoiding hidden default-plus-override behavior. Profiles
may use different execution bounds without changing source or turning a safety
timeout into a performance assertion.

The Scenario, trace, and artifact contracts advance together without a
compatibility bridge. The parser, compiler, migrated corpus, CLI file loading,
runner stabilization, profile conformance, artifacts, and viewer must land as
one implementation slice after this intent change.
