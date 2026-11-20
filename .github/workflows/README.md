# GitHub Workflows

Workflow YAML files in this directory are generated from sibling `.genie.ts`
sources. Edit the Genie sources and regenerate instead of editing YAML outputs.

## `ci.yml`

Primary pull request validation for the contrib workspace. The stable checks
are `source-policy`, `pr/minimal-dev`, `pr/quality`, `pr/types`,
`pr/packages`, `pr/examples-build`, `pr/node`, and `release-surface`.

## `rust.yml`

Validates the Rust client in `rust/`: `rust:check`, `rust:clippy`, `rust:test`,
and `rust:test-live` (against the pinned core's sync-cf worker). It runs only
when `rust/`, its own workflow files, the devenv files, or the megarepo pin
change, and is not a required check.

## `release.yml`

Release workflow surface for contrib packages. It validates that contrib can
read the pinned core version, simulates publish-time package manifest rewrites
for local core/contrib protocols, and publishes snapshot packages after a
successful `ci.yml` run on `main` or explicit `mode=publish-snapshot` dispatch.
Snapshot publishing uses npm trusted publishing from this workflow file. Package
snapshot versions include both the pinned core commit and the contrib commit,
while core dependency rewrites use the pinned core snapshot from
`megarepo.lock`.

An explicit `mode=publish-dev` dispatch on `main` publishes the matching
`contrib_version` and `core_version` under the npm `dev` tag. Both inputs must
be the same `x.y.z-dev.N` prerelease (for example, `0.5.0-dev.0`), and the core
version must already be available on npm. Dev publishing uses the same npm
trusted-publishing workflow identity and rejects token-based authentication.

An explicit `mode=publish-stable` dispatch on `main` publishes identical stable
`core_version` and `contrib_version` values on npm `latest`, after confirming
`@livestore/livestore` already has that version on `latest`. Both dev and stable
jobs verify each package's dist-tag, packed SHA-1/SHA-512 digests, dependencies
and retrievable npm provenance attestation. A mismatch fails the job.
See [`context/release/spec.md`](../../context/release/spec.md#stable-publication-runbook)
for the dispatch and hypothetical stable dry-run runbook.

## Repository Settings

Repository settings are generated from `.github/repository-settings.json.genie.ts`
and `.github/repo-settings.json.genie.ts`. Those typed sources are authoritative;
the generated JSON artifacts are the reviewable and applied projections for
GitHub repository toggles and the `main-branch-rules` ruleset. The separate
`main-code-owner-review` ruleset is generated from
`.github/code-owner-review.json.genie.ts`.

After this change lands on `main`, a repository admin can apply both files from
a checkout of that branch. Apply the code-owner rule first so the approval
requirement stays in force during the migration.

```bash
set -euo pipefail
endpoint=repos/livestorejs/livestore-contrib/rulesets
version='X-GitHub-Api-Version: 2026-03-10'
gh api "$endpoint" --method POST -H "$version" --input .github/code-owner-review.json
gh api "$endpoint/17366197" --method PUT -H "$version" --input .github/repo-settings.json
```

## `cloudflare-spend-guard.yml`

Runs every six hours and on manual dispatch from `main`, using the existing
production environment's `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
`CF_BOT_STATE_NAMESPACE_ID`. It performs read-only analytics requests and
requires no dependency installation or Cloudflare deployment.

The latest complete 24-hour window ends one hour before the current UTC hour.
The check fails above 500 GB-s for production Discord or 1,000 GB-s for the
whole account, compared with approximately 165 and 201 GB-s/day after the fix.
Missing credentials, API errors and missing samples also fail the workflow.
Every run records its window, measured usage and thresholds in the job summary.
Failures use GitHub Actions notifications. An overdue run also needs attention
because scheduled GitHub Actions can be delayed or disabled. This guard covers
DO duration; other billing meters are covered by the account budget alert.

For an attended alert check, dispatch with `production_limit=1`, confirm the
expected failed result, then dispatch with the default 500 to verify recovery.
A manual input can lower this limit but cannot raise it above the scheduled
guard. The account limit remains 1,000 GB-s.
