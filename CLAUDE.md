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

During the pre-package-import phase, use:

```bash
devenv tasks run check:quick --mode before
```

This runs the generated-root checks that are valid before package histories and a real `pnpm-lock.yaml` exist. Do not run or rely on `pnpm install` as a required proof until package manifests have been imported.

Useful focused checks:

```bash
devenv tasks run genie:check --mode before
devenv tasks run mr:check --mode before
mr status -o json
```

## GitHub Issues And Pull Requests

- Keep this bootstrap PR in draft until the maintainer decides it is ready.
- Describe PRs in terms of the problem, approach, validation, trade-offs, and follow-ups.
- Link relevant work back to `livestorejs/livestore#1265`.
- Use existing labels only.

## Secrets

Keep sensitive environment variables in local ignored files such as `.envrc.local`. Never commit credentials or machine-local paths.
