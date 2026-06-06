# GitHub Workflows

Workflow YAML files in this directory are generated from sibling `.genie.ts`
sources. Edit the Genie sources and regenerate instead of editing YAML outputs.

## `ci.yml`

Primary pull request validation for the contrib workspace. The stable checks
are `source-policy` and `check-all`.

## `release.yml`

Release workflow surface for the package import phase. It validates that
contrib can read the pinned core version and that package publishing remains
blocked until publish simulation and release planning are added.
