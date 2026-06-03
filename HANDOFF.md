# Handoff

This repository is the contrib companion to
[`livestorejs/livestore`](https://github.com/livestorejs/livestore).

The architecture source of truth is the latest core spec:
[`context/repo-architecture/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/repo-architecture/spec.md).
Do not duplicate or reinterpret that contract here.

## Current milestone

Milestone 1 is the megarepo skeleton:

- `megarepo.kdl` declares the contrib composition.
- `megarepo.lock` records the resolved commits.
- `repos/` is materialized by `mr` and remains uncommitted.

The contrib megarepo has:

- `livestorejs/livestore` pinned, so contrib development and CI use a
  deterministic core checkout.
- `overengineeringstudio/effect-utils` pinned, matching the shared tooling
  contract.
- `effect-ts/effect` unpinned, matching core's shared dependency contract.

## Package ownership

Package ownership is defined by the core spec. In particular,
`@livestore/framework-toolkit` remains in core because it is shared by React and
contrib framework packages.

Contrib owns the additional LiveStore integrations listed in the spec, including
Svelte, Solid, Node, Expo, Electric, S2, GraphQL, CLI, and contrib devtools
surfaces.

## Local workflow

From the repository root:

```bash
mr fetch --apply
mr status
```

Use `mr fetch --apply` when the intent file should resolve fresh upstream refs
and update `megarepo.lock`. Use `mr apply` when the workspace should be
materialized from the existing lock without changing it.

Do not edit files in materialized `repos/` checkouts as part of this repository's
bootstrap docs/config work.
