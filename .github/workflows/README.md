# GitHub Workflows

Workflow YAML files in this directory are generated from sibling `.genie.ts`
sources. Edit the Genie sources and regenerate instead of editing YAML outputs.

## `ci.yml`

Primary pull request validation for the pre-package-import bootstrap. The
stable checks are `source-policy` and `check-all`.

## `release.yml`

Release workflow surface for the bootstrap phase. It validates that contrib can
read the pinned core version and that the release path remains explicitly
blocked until package histories and publish simulation are added.
