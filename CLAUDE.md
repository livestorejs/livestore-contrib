# Project Instructions

## Repository Shape

This repository is the contrib companion to `livestorejs/livestore`.

- Architecture & contract source of truth: the core **intent layer** at
  `repos/livestore/context/` (see [`livestorejs/livestore`](https://github.com/livestorejs/livestore/tree/main/context)); this repo hosts its own realization intent under `context/` (see Intent Layer below)
- Progress tracker: `livestorejs/livestore#1265`
- Core packages are consumed through the materialized megarepo member at `repos/livestore`
- Shared generator and devenv helpers come from `repos/effect-utils`

## Intent Layer (`context/`)

`context/` is this repo's **realization intent layer** (a VRS tree): one node per contrib package, describing how it realizes a core pluggable dimension (adapter, sync provider, framework integration, devtools surface, query surface). Read [`context/spec.md`](./context/spec.md) for the contrib conventions.

- The **core** intent layer (`repos/livestore/context/`, source: [`livestorejs/livestore`](https://github.com/livestorejs/livestore/tree/main/context)) is the source of truth for the contracts these nodes refine. Reference core contracts by their `LS.*` ID + link — never restate them here. Contrib IDs use the `LSC.*` namespaces and never enter the core ID table.
- When a package's behavior, deviation, or open question changes, update its `context/` node. Confirmed divergence from a core contract → the node's `.delta/`; consequential choices → `.decisions/`.
- A dependency-free enforcement suite mirrors core's: `bun tests/intent-layer/check.ts` (LSC ID uniqueness, namespace↔dir, `refines:` resolution, links, decision shape, maturity vocabulary). Run it and keep it green when editing `context/`. It also resolves `refines: LS.*` against the megarepo-pinned core intent layer when that pin carries `context/`.

## Development Environment

Use `devenv` for the pinned toolchain:

```bash
devenv shell
```

If tools are not directly available in `$PATH`, enter the dev environment first.

## Common Checks

Use the full repository check before pushing:

```bash
devenv tasks run check:all --mode before
```

This validates generated files, linting, TypeScript, megarepo source policy,
the root `pnpm-lock.yaml`, and the contrib/core composed workspace shape.
`repos/livestore` is dereferenced during megarepo bootstrap so pnpm can own the
materialized core package closure in the lockfile.

Useful focused checks:

```bash
devenv tasks run genie:check --mode before
devenv tasks run mr:check --mode before
devenv tasks run pnpm:install --mode before
devenv tasks run release:surface:check --mode before
mr status -o json
```

## GitHub Issues And Pull Requests

- Describe PRs in terms of the problem, approach, validation, trade-offs, and follow-ups.
- Link relevant work back to `livestorejs/livestore#1265`.
- Use existing labels only.

## Secrets

Keep sensitive environment variables in local ignored files such as `.envrc.local`. Never commit credentials or machine-local paths.
