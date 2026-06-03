# `@livestorejs/livestore-contrib`

Community packages for [LiveStore](https://github.com/livestorejs/livestore):
additional framework integrations, platform adapters, sync providers, devtools,
GraphQL integration, and CLI tooling.

## Status: bootstrap in progress

This repository is being bootstrapped as the contrib companion to
[`livestorejs/livestore`](https://github.com/livestorejs/livestore).

The architecture source of truth lives in
[`livestorejs/livestore` at `context/repo-architecture/`](https://github.com/livestorejs/livestore/tree/main/context/repo-architecture).

## Megarepo composition

This repo is composed with:

- `livestorejs/livestore`, pinned, for deterministic contrib development and CI.
- `overengineeringstudio/effect-utils`, pinned, for shared tooling.
- `effect-ts/effect`, unpinned, matching core's shared dependency contract.

Run:

```bash
mr fetch --apply
mr status
```

The materialized repositories are symlinked under `repos/`, which is not
committed.
