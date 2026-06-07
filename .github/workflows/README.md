# GitHub Workflows

Workflow YAML files in this directory are generated from sibling `.genie.ts`
sources. Edit the Genie sources and regenerate instead of editing YAML outputs.

## `ci.yml`

Primary pull request validation for the contrib workspace. The stable checks
are `source-policy`, `check-all`, and `release-surface`.

## `release.yml`

Release workflow surface for contrib packages. It validates that contrib can
read the pinned core version, simulates publish-time package manifest rewrites
for local core/contrib protocols, and keeps package publishing blocked until
release planning is added.

## Repository Settings

Repository settings are generated from `.github/repository-settings.json.genie.ts`
and `.github/repo-settings.json.genie.ts`. The generated JSON artifacts are the
source of truth for GitHub repository toggles and the `main-branch-rules`
ruleset.
