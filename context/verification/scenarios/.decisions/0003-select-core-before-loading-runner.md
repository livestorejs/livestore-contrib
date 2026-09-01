# 0003 — Select core source before loading the Scenario runner

Status: accepted (source launcher, projection recovery, and provenance tests,
2026-08-01)

## Context

The private Scenario workspace links development packages through the fixed
`repos/livestore` materialization. Its CLI previously imported those packages
before parsing arguments, which made the checked-in megarepo commit the only
practical execution source and made local artifacts identify only a generic
working tree. Contributors need to exercise one solution branch or dirty local
worktree at a time without first publishing a LiveStore snapshot.

The composed pnpm workspace deliberately dereferences megarepo symlinks. A
temporary `mr pin` both mutates repository intent and expects to replace a
symlink, so it is not the execution-time selection mechanism.

## Decision

Make `scenario:run` an outer launcher with mutually exclusive `--core-ref` and
`--core-path` selectors. The launcher resolves and validates the source before
spawning the existing product-importing CLI. It projects the selected source at
`repos/livestore` under an exclusive lock, preserves the original physical
materialization by rename, restores it in a `finally` boundary, and repairs an
abandoned projection only when its owning process is dead.

A Git ref is materialized as a detached managed worktree beside
`repos/livestore`. It may reuse the current composed package links only when the
runtime dependency declarations of the Scenario closure match. A local path is
never modified by the launcher and must already carry its own installed
workspace dependencies. This path supports committed, dirty, and untracked
source from any ordinary LiveStore worktree.

Record `livestore@<commit>` as artifact source identity and append a hash of the
tracked binary diff plus untracked file contents when dirty. Print the selected
local path for the operator but never persist it in the artifact. Surface a
compact revision in the viewer's saved-run selector and the complete identity
in a single unobtrusive provenance line on the open run.

## Consequences

Implementation-only core changes execute directly through `tsx`, Vite, and
Wrangler without a build or npm snapshot. Dependency-changing refs require an
installed local worktree rather than silently mixing graphs. Selection is
serialized within one contrib worktree; independent contrib worktrees can run
different LiveStore sources concurrently. The canonical megarepo config and
lock remain unchanged by experimental runs.
