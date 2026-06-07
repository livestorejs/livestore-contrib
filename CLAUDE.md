# Project Instructions

## Repository Shape

This repository is the contrib companion to `livestorejs/livestore`.

- Architecture source of truth: `repos/livestore/context/repo-architecture/`
- Progress tracker: `livestorejs/livestore#1265`
- Core packages are consumed through the materialized megarepo member at `repos/livestore`
- Shared generator and devenv helpers come from `repos/effect-utils`

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
