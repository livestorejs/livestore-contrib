# Handoff — repo split execution

You are inheriting the execution of the LiveStore repo split. All design
intent and execution plumbing already exists. Your job is to drive the
work from "PRs opened, design landed" to "atomic merge complete, issues
transferred, orphaned PRs cleaned up."

This document is the single entry point. Everything you need is reachable
from here.

## Read first

1. **VRS** — `livestorejs/livestore` at
   [`context/repo-split/`](https://github.com/livestorejs/livestore/tree/dev/context/repo-split):
   vision.md, requirements.md, spec.md, and the consolidated ADR at
   `decisions/0001-two-repo-composition.md`. The spec contains the
   composition topology diagram, the package classification table, the
   release flow, and the genie composition mechanics. **Treat the spec as
   authoritative when execution detail collides with anything else in
   this document.**
2. **Epic** — [`livestorejs/livestore#1265`](https://github.com/livestorejs/livestore/issues/1265):
   the execution checklist. **Update this issue's status table and
   checkboxes as each step lands.** It is the single source of truth for
   progress. The maintainer reads it to see where we are.
3. **Announcement** — [`livestorejs/livestore#1263`](https://github.com/livestorejs/livestore/issues/1263):
   the public framing. Do not contradict it; do not editorialize beyond it
   in any artifact you produce.
4. **VRS PR** — [`livestorejs/livestore#1267`](https://github.com/livestorejs/livestore/pull/1267):
   draft. Lands the VRS docs. Likely already merged by the time you read
   this — if not, that's your first step (it's docs-only, low risk).
5. **Contrib bootstrap PR** — [`livestorejs/livestore-contrib#1`](https://github.com/livestorejs/livestore-contrib/pull/1):
   draft. Your accretion target for the bootstrap commits.

## North star

Land the two-repo split exactly as specified in `context/repo-split/`.
The success criteria in `vision.md` define what "done" looks like.

## Final package classification

Lifted from `context/repo-split/spec.md`. Do not re-derive.

**Stays in `livestorejs/livestore` (core, 14):**
`livestore`, `common`, `common-cf`, `utils`, `utils-dev`, `peer-deps`,
`react`, `adapter-web`, `adapter-cloudflare`, `sync-cf`, `sqlite-wasm`,
`wa-sqlite`, `webmesh`, `framework-toolkit`.

**Moves to `livestorejs/livestore-contrib` (10):**
`svelte`, `solid`, `adapter-node`, `adapter-expo`, `devtools-expo`,
`devtools-web-common`, `sync-electric`, `sync-s2`, `graphql`, `cli`.

Plus 11 example apps that demonstrate moving packages — enumerated in
the derisking proof (see "Derisking artifacts" below).

`@livestore/effect-playwright` is independent (issue `livestorejs/livestore#1259`,
target = effect-utils).

## Working environment

- Both repos materialize under
  `/home/schickling/.megarepo/github.com/livestorejs/{livestore,livestore-contrib}/refs/heads/<branch>/`.
- Your worktrees:
  - VRS PR work: `livestore/refs/heads/schickling-assistant/2026-06-01-vrs-repo-split/`
  - Contrib bootstrap: `livestore-contrib/refs/heads/schickling-assistant/2026-06-01-bootstrap/`
- The `mr` CLI is in PATH. So is `gh`, `bun`, `pnpm` (11.0.0-rc.5 today;
  jumps to 11.3 once core's #1258 merges), `oxlint`, `oxfmt`, and the
  `devenv` task runner via `devenv tasks run <name>`.
- `gh` is pre-configured to use the `schickling-assistant` account via
  `GH_CONFIG_DIR`.
- `genie` binary is at
  `/nix/store/ghnn8xybcfs0iw5s5gpmhjhi7m8j2qza-genie/bin/genie` (or
  whatever recent path is available — `find /nix/store -maxdepth 3 -name
  genie -type f -executable 2>/dev/null | head` will locate it).

## Constraints

These are non-negotiable. Violations require an immediate pause + manager
ping.

- **Do not "leak" beyond the announcement framing.** No sponsor names, no
  team-bandwidth framing, no editorialization about why specific packages
  moved. Stick to structural descriptions in every artifact you produce
  (PR titles, PR bodies, commit messages, issue comments, public docs).
- **Do not flip either PR from draft → ready.** The maintainer does that.
- **Do not enroll either PR in Hypermerge** (no `mq:enrolled` label).
  The maintainer enrolls.
- **Do not push to or modify canonical worktrees** belonging to branches
  you don't own. Your own worktrees are fine.
- **Do not skip CLAUDE.md's pre-commit check.** Run `devenv tasks run
  check:quick` (or the equivalent) locally before pushing. If it fails on
  pre-existing drift (e.g. `mr:lock-sync-check`), document the drift in
  the PR body and proceed — but the *new code* must pass.

## Communication protocol

- **Blockers + ambiguities** — ping the maintainer in the same chat where
  you're being driven from. Do not guess on items that aren't covered by
  the VRS or this document.
- **Progress** — update the status table in the epic
  [`#1265`](https://github.com/livestorejs/livestore/issues/1265) as you
  land each step. Tick the checkboxes; update the per-row status; keep
  the status table near the bottom of the body authoritative.
- **Public-facing posts** — every comment/PR body/issue body you write
  passes the "would I want this surface visible to the entire community?"
  test. If unsure, default to no.

## Work tracks

Three tracks run in parallel; one serial spine gates the atomic merge.

### Track A — VRS PR (`livestorejs/livestore#1267`)

If still open, land it. Verify CI green (it should be — docs-only). Ping
maintainer for review. Once merged, the canonical design lives in
`context/repo-split/` on core's `dev`.

### Track B — Prep PR on core: re-export CI step atoms

`livestore/genie/repo.ts` currently re-exports the composite
`livestoreSetupSteps` but not its constituent atoms (`installNixStep`,
`applyMegarepoLockStep`, `restorePnpmStateStep`, etc.). Contrib needs
those atoms to compose its own CI setup without inheriting livestore's
cachix cache name and pnpm state key.

Open a new branch on livestore (e.g.
`schickling-assistant/2026-06-01-genie-reexport-ci-atoms`). Add the
re-exports, run `dt lint:full:fix` + `devenv tasks run check:quick`,
open a draft PR linking to epic #1265. Wait for review.

### Track C — Contrib bootstrap PR (`livestorejs/livestore-contrib#1`)

This is the bulk of the work. Accrete commits onto the existing branch
on `livestore-contrib`. Suggested commit sequence:

1. **megarepo skeleton**: `megarepo.kdl` listing `livestore` (pinned,
   tracking `main`) and `overengineeringstudio/effect-utils` (pinned,
   tracking `main`). Run `mr fetch --apply` to materialize. Verify
   `repos/livestore/` and `repos/effect-utils/` symlinks exist.
2. **Devenv + Nix**: `devenv.nix`, `devenv.yaml`, `flake.nix`, `.envrc`,
   mirroring livestore's shape but with contrib identifiers (cachix
   cache name `livestore-contrib`, pnpm state key prefix
   `livestore-contrib-pnpm-state-v1`).
3. **Genie projections that don't depend on the prep PR landing yet**:
   `genie/external.ts` (contrib-only catalog extensions),
   `genie/internal.ts` (contrib repo refs),
   `genie/repo.ts` (re-exports from `../repos/livestore/genie/repo.ts`
   via **relative path**, not `#mr/`; see ADR 0001),
   `pnpm-workspace.yaml.genie.ts`,
   `package.json.genie.ts`,
   `tsconfig.dev.json.genie.ts`,
   `.oxlintrc.json.genie.ts`,
   `.oxfmtrc.json.genie.ts`.
4. **CI workflow**: Once the prep PR (Track B) merges and the atoms are
   available, add `.github/workflows/ci.yml.genie.ts` composing contrib's
   CI from those atoms. Until then, ship a minimal CI that does
   pnpm-install + lint + ts:check only.
5. **Release workflow**: `.github/workflows/release.yml.genie.ts` reads
   core's version from `repos/livestore/package.json`, stamps contrib
   packages at that version, rewrites `workspace:*` to the pinned exact
   version, publishes. Triggered by `repository_dispatch` from core's
   release workflow + by `workflow_dispatch` for manual operation.
6. **Labels + repo settings IaC**: `.github/labels.json.genie.ts` and
   `.github/repo-settings.json.genie.ts` composing from effect-utils'
   shared catalog. No `tier:*` labels (the prior tiering exploration is
   closed). Apply via `dt gh:apply-labels` once the genie file generates.
7. **CLAUDE.md, LICENSE, CODEOWNERS, ISSUE_TEMPLATE, pull_request_template**:
   mirror core's shape, light contrib-specific adjustments where
   identifiers leak through.
8. **Migrated package histories**: run `git filter-repo` against a fresh
   clone of `livestorejs/livestore` to extract the 10 package paths + 11
   example paths with history preserved. Graft onto contrib's `main`.
   The exact invocation, expected output size, and the surprises to
   watch for are documented in the derisking artifact at
   `/home/schickling/tmp/derisk-filter-repo/` — re-read it before
   executing.

   Note: the derisking artifact's filter-repo command includes
   `framework-toolkit` in the moving set. **Drop that path from your
   final invocation** — per ADR 0001, framework-toolkit stays in core.

9. **`pnpm install` validation**: from contrib's root,
   `CI=1 pnpm install --no-frozen-lockfile`. Verify `@livestore/svelte`
   resolves `@livestore/react` as a `link:` workspace entry pointing
   into `repos/livestore/packages/@livestore/react`. Test command:
   `pnpm --filter @livestore/svelte list --depth 0`. The derisking
   artifact at `/home/schickling/tmp/derisk-filter-repo/contrib-synthetic/`
   has the working reference.
10. **`devenv tasks run check:quick`** locally. Triage any failures.
    `mr:lock-sync-check` may flag pre-existing drift between
    `megarepo.lock` and `devenv.lock` — document and proceed.

Keep the PR in draft. Update the body as sections land.

### Serial spine — gates the atomic merge

1. Wait for `livestorejs/livestore#1258` to merge into `dev`.
2. Wait for `livestorejs/livestore#1198` (0.4.0 release) to ship.
   (Maintainer-driven; you do not execute the release.)
3. Open the **core deletion PR** on a new branch on livestore. Delete
   the 10 package directories, 11 example directories, the entries in
   `genie/external.ts`'s `livestoreWorkspaceCatalog` and
   `livestorePackageNames`, the entries in `package.json.genie.ts`'s
   `rootWorkspacePackages`, the entries in `tsconfig.dev.json.genie.ts`'s
   project references, the entries in `.changeset/config.json`'s fixed
   group. Move `tests/package-common/` test files that import
   `@livestore/adapter-node` into contrib. Retarget docs site TypeDoc
   entry points and code-snippet imports through `repos/livestore-contrib/...`.
   Add `livestore-contrib` to core's `megarepo.lock` as an **unpinned**
   member (default for new entries; do not run `mr config pin`). Wire
   docs build's `mr fetch --only livestore-contrib --apply` step.

   The dependency-graph breakage audit at
   `/home/schickling/tmp/derisk-deps-audit/` (or whatever the agent's
   output file is) has the exact file:line citations for every
   deletion site. Re-read before executing — it's the canonical
   diff specification.

4. **Atomic merge.** Coordinate with maintainer. Order:
   - Contrib bootstrap PR merges first.
   - Core deletion PR merges within the same window.
5. **First contrib release.** Maintainer-driven, validates the lockstep
   flow.
6. **Issue transfer.** Use `gh issue transfer` for issues labeled
   `adapter:node`, `adapter:expo`, `integration:svelte`,
   `integration:solid`, `syncing:electric`, `syncing:s2`, `cli`, etc.
   Reference the live label set when filtering — there's a small
   number with mixed scope that need manual triage.
7. **Orphaned PR cleanup.** Notify authors of `#502`, `#1231`, `#1013`,
   `#994`, `#991`, `#401`, `#448`, `#460` with rebase guidance per the
   pattern documented in epic #1265.

## Derisking artifacts

These are scratch workspaces from the planning phase. Re-read before
executing the corresponding step. **Do not modify them.**

| Workspace | Validates |
|---|---|
| `/home/schickling/tmp/asymmetric-mr-proof/` | Approach A′: asymmetric megarepo with contrib unpinned in core's lock. Includes the proven `mr` invocations. |
| `/home/schickling/tmp/derisk-filter-repo/` | `git filter-repo` extraction + pnpm-workspace-over-symlink resolution. Contains a working contrib-synthetic with `@livestore/svelte` resolving `@livestore/react` as a workspace `link:` entry. |
| `/home/schickling/tmp/derisk-genie-composition/` | Cross-repo genie composition via relative paths (not `#mr/`). Contains a working contrib-synthetic that generates a CI workflow consuming livestore's helpers. |

## Validation checklist before flipping draft → ready

The maintainer flips draft → ready, not you. But before you ping for
review, the bootstrap PR must satisfy:

- `devenv tasks run check:quick` passes locally (or pre-existing drift
  is documented).
- `pnpm install` from contrib's root succeeds with the workspace
  resolving core packages via the symlink.
- `genie` produces zero "failed" file outputs (only "unchanged",
  "created", "updated" allowed).
- `gh pr checks <pr>` shows green on CI.
- Issue #1265's status table reflects all completed steps.
- Issue #1265's checklist has the checkboxes ticked for every section
  in the bootstrap PR's scope.

## Anti-checklist (things not to do)

- Do not run `mr fetch --all` from core — use `--only livestore-contrib`
  to avoid nested re-materialization (see ADR 0001 / derisking notes).
- Do not import `#mr/livestore/...` from contrib's genie files — use
  relative paths into `../repos/livestore/genie/...` (see ADR 0001).
- Do not preserve history for `framework-toolkit` — it stays in core
  (see ADR 0001).
- Do not add `tier:*` labels — that exploration is closed
  (see `livestorejs/livestore#1261`, closed).
- Do not push, comment, or modify anything on
  `overengineeringstudio/effect-utils` — that's the upstream prep PR's
  responsibility for the `effect-playwright` move (#1259).
- Do not run `pnpm install` on the canonical megarepo-store checkout
  of livestore — pnpm writes `node_modules` into workspace members
  which must be writable. Materialize a regular `mr apply` checkout in
  contrib instead.

## Where to look when stuck

- **VRS / ADR** — first stop for any architectural question.
- **Epic #1265** — for execution sequence.
- **Derisking artifacts** — for "does this actually work?" reproducible
  proofs.
- **Canonical livestore worktree** at
  `/home/schickling/.megarepo/github.com/livestorejs/livestore/refs/heads/main/`
  (or `/dev/` for the active branch) — for "how does core do this?"
  questions. Mirror the patterns; don't invent.
- **Manager** — for anything that isn't covered above. Ping in the
  driving chat. Do not guess on items with PR-merge consequences.
