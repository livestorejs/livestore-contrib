# GitHub Workflows

Workflow YAML files in this directory are generated from sibling `.genie.ts`
sources. Edit the Genie sources and regenerate instead of editing YAML outputs.

## `ci.yml`

Primary pull request validation for the contrib workspace. The stable checks
are `source-policy`, `pr/minimal-dev`, `pr/quality`, `pr/types`,
`pr/packages`, `pr/examples-build`, `pr/node`, and `release-surface`.

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

Stable release publishing remains blocked until release-plan generation and
approval are added.

## Repository Settings

Repository settings are generated from `.github/repository-settings.json.genie.ts`
and `.github/repo-settings.json.genie.ts`. Those typed sources are authoritative;
the generated JSON artifacts are the reviewable and applied projections for
GitHub repository toggles and the `main-branch-rules` ruleset.
