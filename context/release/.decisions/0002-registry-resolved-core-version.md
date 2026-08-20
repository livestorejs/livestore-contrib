# 0002 — Resolve the core version from the registry

Status: accepted

## Context

A published contrib package must depend on the core build its branch composed.
The previous implementation derived that version as `0.0.0-snapshot-<sha>`.

## Evidence

That shape is only correct for core commits on the default branch. A core
pull-request head publishes as `0.0.0-snapshot-pr.<n>.<sha>`. Contrib pinning a
core pull request is exactly the situation PR snapshots exist to support, so the
derivation was wrong in the motivating case.

Both shapes end in the SHA. Resolution by suffix over published versions
returned exactly one match for a core pull-request head, exactly one for a core
default-branch head, and none for a SHA that was never published.

## Decision

Resolve the core version by selecting the unique published version whose suffix
is the pinned core SHA, and fail when zero or several match. Failing on
ambiguity keeps the result deterministic instead of guessing a prefix.

Recording the version in a committed file was rejected: it duplicates a fact the
lockfile already carries and can drift from it.
