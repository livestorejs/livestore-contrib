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

Use the pinned toolchain:

```bash
devenv shell
```

Materialize the composed workspace from the checked-in megarepo lock:

```bash
mr apply
```

Refresh remote refs and update `megarepo.lock` only when intentionally moving
the composed dependency graph:

```bash
mr fetch --apply
```

Run the full local validation before pushing:

```bash
devenv tasks run check:all --mode before
```

Focused checks:

```bash
devenv tasks run release:surface:check --mode before
devenv tasks run workspace:shape-check --mode before
devenv tasks run mr:check --mode before
git diff --check
```

## Release Surface

Publishing is guarded by a release-surface check. It reads the pinned core
release version and simulates publish-time package manifests so local
`link:` core dependencies and `workspace:` contrib dependencies are rewritten to
publishable versions before a real release plan can be enabled.

Real publish dispatch remains gated on release-plan generation and approval.

## Repository Settings

GitHub repository settings are generated from `.github/*.genie.ts` sources. The
checked-in JSON artifacts define repository toggles and the `main-branch-rules`
ruleset, including the required `source-policy`, `check-all`, and
`release-surface` checks.
