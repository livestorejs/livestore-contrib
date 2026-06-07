# GitHub Workflows

Workflow YAML files in this directory are generated from sibling `.genie.ts`
sources. Edit the Genie sources and regenerate instead of editing YAML outputs.

## `ci.yml`

Primary pull request validation for the contrib workspace. The stable checks
are `source-policy` and `check-all`.

## `release.yml`

Release workflow surface for contrib packages. It validates that contrib can
read the pinned core version, simulates publish-time package manifest rewrites
for local core/contrib protocols, and keeps package publishing blocked until
release planning is added.
