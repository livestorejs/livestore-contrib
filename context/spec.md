# Contrib Intent Layer — Spec

This document specifies the composition of the contrib intent layer. Core
conventions (node shape, maturity markers, `refines:` style, review smells)
are defined in the
[core intent layer](https://github.com/livestorejs/livestore/blob/main/context/spec.md)
and apply here unchanged; this file defines only what differs.

## Status

Draft.

## Node Layout

One node per contrib package, grouped by the core dimension it realizes:

```
context/
  adapters/        realize core 02-system/04-runtime/ (adapter contract)
    node/  expo/
  sync/            realize core 02-system/03-sync/ (provider contract)
    electric/  s2/
  integrations/    realize core 02-system/08-integrations/
    solid/  svelte/  graphql/
  devtools/        realize core 02-system/07-devtools/ (surface contract)
    expo/
```

Nodes are created lazily as their intent is captured; `adapters/node/` and
`sync/electric/` are seeded first. The `cli` package realizes no core
dimension and gets a top-level node when its intent is captured.

## ID Scheme

Contrib IDs use the `LSC` prefix, mirroring the core style:
`LSC.ADAPT.NODE-*`, `LSC.ADAPT.EXPO-*`, `LSC.SYNC.ELECTRIC-*`,
`LSC.SYNC.S2-*`, `LSC.INT.SOLID-*`, `LSC.INT.SVELTE-*`, `LSC.INT.GQL-*`,
`LSC.DT.EXPO-*`. Contrib IDs never enter the core namespace table; core
contracts are referenced by their `LS.*` IDs with links.

## Relationship to Core

- Core contracts constrain realizations here; a contrib node states
  deviations explicitly rather than silently diverging.
- The core registries
  (`context/02-system/<dimension>/realizations.md`) list every realization;
  when a node is added here, the corresponding registry row links it.
- Conformance suites live in core (`02-system/09-verification/`); a contrib
  realization's conformance status is tracked in the core registry.
