# 0006 — Preserve Operation, Settlement, and property evidence boundaries

Status: accepted (operation-history, fault/recovery, Settlement, oracle, and
failed-artifact tests in `tests/scenarios`, 2026-08-01); authored terminal
Settlement and timeout placement superseded by decision 0012

## Context

An issued request, a host response, a later product observation, Recovery, a
stable convergence barrier, and a property verdict answer different questions.
Combining them into one success signal would turn requested controls into
observed behavior, hide lost-response uncertainty, make Fault removal look like
Recovery, or let a property verdict rewrite whether Settlement completed.

## Decision

Every runner-invoked operation keeps stable identity across its instruction,
host response, related observations, and outcome. A host acknowledgement proves
only handling at the host boundary. Success, definite failure, indefinite
outcome, and the Participant-host failure category are independent facts; a
timeout or lost response never proves that the requested effect did not occur.

Record Fault request, acknowledgement, observed injection or removal,
Recovery, Quiescence, and Settlement separately. Fault removal ends the
observed injected condition but does not establish Recovery. A Settlement
names its participant group and timeout, rejects other in-flight operations,
and records a bounded, repeated stable-poll convergence barrier.

Scenario oracles evaluate explicit properties from retained evidence and emit
separate verdicts. Settlement alone proves neither Eventlog equality nor State
equality, and a failed property does not alter the Settlement record. Snapshot
properties require terminal Settlement for their participants; history and
sampled-prefix properties declare their own evidence boundaries.

Once participant execution begins, any operation or Settlement failure retains
the complete available trace prefix in a failed artifact. Scenario authoring or
validation before the run starts may fail without producing an artifact.

## Consequences

Operation-history projections state the operation families and
instruction-to-control-outcome concurrency boundary they cover. Recovery and
bounded liveness remain compositional claims over actual observations rather
than hidden signals. Diagnostic consumers can explain failure without
upgrading absence, acknowledgement, or matching heads into stronger evidence.
