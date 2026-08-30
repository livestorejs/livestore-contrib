# 0003 - Require explicit apply for control-plane mutations

Status: accepted

## Context

Operator commands can mutate production Discord state and the action journal.
Command names alone are easy to paste from an issue or runbook without noticing
the selected environment.

## Decision

Every control-plane mutation requires an explicit environment, `--apply`, and a
non-empty operator reason. Read-only plan/diff commands are separate commands,
not boolean modes that may accidentally write. There is no `--force` bypass for
scope, authorization, existing-thread, or ambiguous-effect protections.

Accepted 2026-08-23.
