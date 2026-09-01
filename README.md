# LiveStore Contrib

Community packages for [LiveStore](https://github.com/livestorejs/livestore):
framework integrations, platform adapters, sync providers, devtools, GraphQL
integration, and CLI tooling that live outside the core engine repository.

The repository architecture source of truth is maintained in
[`livestorejs/livestore`](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/.decisions/0001-two-repo-composition.md).

## Packages

This repository contains the contrib-owned `@livestore/*` packages under
`packages/@livestore/` and example applications under `examples/`.

Core LiveStore packages are consumed from the pinned `livestore` megarepo member
under `repos/livestore`; they remain owned by
[`livestorejs/livestore`](https://github.com/livestorejs/livestore).

## Scenario Verification

The private [`tests/scenarios`](./tests/scenarios) workspace runs portable sync
stories against real LiveStore components and produces replayable evidence for
the artifact viewer. Start with the
[scenario runner guide](./tests/scenarios/README.md) to set up the workspace,
run or author a scenario, and inspect the result.

## Development

Choose the smallest setup that covers the work. The core
[developer-environment spec](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/01-developer-environment/spec.md)
and [requirements R02-R06](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/01-developer-environment/requirements.md#requirements)
define the shared boundary.

| Setup | Use it for | Start here |
| --- | --- | --- |
| Minimal Setup | Ordinary TypeScript, package tests, and web or Worker builds | [Minimal Setup guide](./contributor-docs/development/minimal-setup.md) |
| Full Setup (Nix + devenv) | Generators, browsers, native platforms, releases, and repository-wide checks | [Full Setup guide](./contributor-docs/development/full-setup.md) |

For the default host-native path, verify the prerequisites described in the
Minimal Setup guide and run:

```bash
./scripts/minimal-setup.sh
```

## Release Surface

Publishing is guarded by a release-surface check and the generated release
workflow. The release surface reads the pinned core version and simulates
publish-time package manifests so local `link:` core dependencies and
`workspace:` contrib dependencies are rewritten to publishable versions.

Snapshot publishing is centralized in `.github/workflows/release.yml` so npm
trusted publishing has one workflow identity per package. Package snapshot
versions include both the pinned core commit and the contrib commit, while core
dependency rewrites use the pinned core snapshot from `megarepo.lock`.

Stable release dispatch remains gated on release-plan generation and approval.

## Repository Settings

GitHub repository settings are generated from `.github/*.genie.ts` sources. The
checked-in JSON artifacts define repository toggles and the `main-branch-rules`
ruleset, including the required `source-policy`, `pr/minimal-dev`, `pr/quality`,
`pr/types`, `pr/packages`, `pr/examples-build`, `pr/node`, and
`release-surface` checks.
