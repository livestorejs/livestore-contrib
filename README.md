# LiveStore Contrib

Community packages for [LiveStore](https://github.com/livestorejs/livestore):
framework integrations, platform adapters, sync providers, devtools, GraphQL
integration, and CLI tooling that live outside the core engine repository.

The repository architecture source of truth is maintained in
[`livestorejs/livestore`](https://github.com/livestorejs/livestore/tree/main/context/repo-architecture).

## Packages

This repository contains the contrib-owned `@livestore/*` packages under
`packages/@livestore/` and example applications under `examples/`.

Core LiveStore packages are consumed from the pinned `livestore` megarepo member
under `repos/livestore`; they remain owned by
[`livestorejs/livestore`](https://github.com/livestorejs/livestore).

## Development

Developer-environment readiness is governed by the core
[LS.DEL.COMP.DEV-R01 contract](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/01-developer-environment/requirements.md#requirements).

### Minimal Setup

The default host-native setup requires Git, Bun, Node.js 24, and the exact pnpm
version declared by `package.json#packageManager`. Bootstrap the exact core
revision and frozen workspace dependencies with:

```bash
./scripts/minimal-setup.sh
```

The script reads the core URL and commit from `megarepo.lock`, verifies the
installed pnpm version against `package.json`, and runs a frozen install. Use
pnpm directly for focused commands:

```bash
pnpm --dir packages/@livestore/solid exec tsc -b ../../../tsconfig.dev.json
```

The Dockerfile runs the finite Minimal Setup oracle. Compose optionally provides
an interactive shell over a dedicated checkout:

```bash
docker compose build
docker compose run --rm dev
./scripts/minimal-setup.sh
```

Compose bind-mounts the checkout, so one host or container must exclusively own
its generated files, `repos/livestore`, and dependency state at a time. Use a
separate checkout instead of switching an initialized checkout between host and
container ownership.

The Minimal Setup oracle covers the full TypeScript graph, stable package unit
suites, CLI execution, Node adapter integration, one Vite build, and a local
Wrangler dry run. Browser tests, Expo native/runtime validation, generators,
release commands, and publication require the full environment or their
platform-specific toolchains.

### Full Nix environment

Use devenv when working on generated sources, releases, browsers, native
platforms, or the complete repository contract. Shell entry prepares the locked
composed workspace, dependencies, and generated sources; TypeScript and
validation remain explicit:

```bash
devenv shell
devenv tasks run check:all --mode before
```

For explicit reproducible preparation without entering a shell:

```bash
devenv tasks run setup:strict --mode before
```

Refresh remote refs and update `megarepo.lock` only when intentionally moving
the composed dependency graph:

```bash
mr fetch --apply
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
