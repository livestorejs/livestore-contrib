# 0004 - Treat an existing thread as already satisfied

Status: accepted

## Context

Repeated manual or automatic requests must not create another thread when the
source already has one. Archived or locked threads must not be mutated merely
to satisfy a duplicate request.

## Decision

An existing visible thread produces `AlreadySatisfied` and its link may be
returned to the invoker. Archived or locked state also produces an explicit
already-satisfied/no-mutation outcome. No duplicate creation is attempted.

Accepted 2026-08-23.
