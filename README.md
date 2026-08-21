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

### Full environment

Use the pinned toolchain. Shell entry prepares the locked composed workspace,
dependencies, and generated sources; TypeScript and repository validation stay
explicit:

```bash
devenv shell
devenv tasks run check:all --mode before
```

For an explicit reproducible setup without entering a shell:

```bash
devenv tasks run setup:strict --mode before
```

Refresh remote refs and update `megarepo.lock` only when intentionally moving
the composed dependency graph:

```bash
mr fetch --apply
```

### Portable environment

The Dockerfile is the finite cold-start oracle; Compose adds an interactive
shell over the current checkout:

```bash
docker compose build
docker compose run --rm dev
```

Inside a fresh Compose shell, materialize the exact core commit from
`megarepo.lock`, then install the frozen workspace:

```bash
core_url="$(bun -e 'const lock = await Bun.file("megarepo.lock").json(); console.log(lock.members.livestore.url)')"
core_commit="$(bun -e 'const lock = await Bun.file("megarepo.lock").json(); console.log(lock.members.livestore.commit)')"
mkdir -p repos/livestore
git -C repos/livestore init
git -C repos/livestore fetch --depth=1 "$core_url" "$core_commit"
git -C repos/livestore checkout --detach FETCH_HEAD
pnpm install --frozen-lockfile
```

Compose bind-mounts the checkout, so one host or container must exclusively own
its generated files, `repos/livestore`, and dependency state at a time. Use a
separate checkout before switching between host and container ownership.

The portable oracle covers the full TypeScript graph, stable package unit
suites, CLI execution, Node adapter integration, one Vite build, and a local
Wrangler dry run. Browser tests, Expo native/runtime validation, generators,
release commands, and publication require the full environment or their
platform-specific toolchains.

Focused full-environment checks:

```bash
devenv tasks run release:surface:check --mode before
devenv tasks run workspace:shape-check --mode before
devenv tasks run mr:check --mode before
git diff --check
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
ruleset, including the required `source-policy`, `pr/quality`, `pr/types`,
`pr/packages`, `pr/examples-build`, `pr/node`, and `release-surface` checks.
