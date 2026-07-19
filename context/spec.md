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
    solid/  svelte/
  query-surfaces/  realize core 05-store/01-reactivity/ (query-kind contract)
    graphql/
  devtools/        realize core 02-system/07-devtools/ (surface contract)
    expo/
  cli/             standalone tool; realizes no core dimension
```

Every contrib package has a node. `cli` realizes no core dimension and lives at
the top level. `graphql` is a query-surface (a new live-query kind), not a
framework binding, so it lives under `query-surfaces/` and refines the core
reactivity contract rather than the integration contract (LSC-DQ1, resolved).

## ID Scheme

Contrib IDs use the `LSC` prefix, mirroring the core style. Contrib IDs never
enter the core namespace table; core contracts are referenced by their `LS.*`
IDs with links (see below).

| Namespace | Node |
| --- | --- |
| `LSC-*` | root |
| `LSC.ADAPT.NODE-*` | `adapters/node/` |
| `LSC.ADAPT.EXPO-*` | `adapters/expo/` |
| `LSC.SYNC.ELECTRIC-*` | `sync/electric/` |
| `LSC.SYNC.S2-*` | `sync/s2/` |
| `LSC.INT.SOLID-*` | `integrations/solid/` |
| `LSC.INT.SVELTE-*` | `integrations/svelte/` |
| `LSC.QS.GQL-*` | `query-surfaces/graphql/` |
| `LSC.DT.EXPO-*` | `devtools/expo/` |
| `LSC.CLI-*` | `cli/` |

Realization sub-nodes (if any) extend their namespace with one more segment and
live under the parent's directory. IDs are sequential per namespace.

## Relationship to Core

- Core contracts constrain realizations here; a contrib node states
  deviations explicitly rather than silently diverging.
- The core registries
  (`context/02-system/<dimension>/realizations.md`) list every realization;
  when a node is added here, the corresponding registry row links it.
- Conformance suites live in core (`02-system/09-verification/`); a contrib
  realization's conformance status is tracked in the core registry.

## Enforcement

The mechanical invariants above are enforced by a Vitest suite at
`tests/intent-layer/` (checks in `src/checks.ts`). It mirrors the core suite —
ID uniqueness, namespace↔directory mapping (parsed from the ID Scheme table
above), `refines:` target resolution, relative-link integrity, spec `Status`
headers, absence of empty companion dirs, decision-record shape, and the
maturity vocabulary — and adds the **cross-repo** half: a `refines:` marker may
target a core `LS.*` ID, resolved against the megarepo-pinned core intent layer
at `repos/livestore/context/`. When the pinned core rev predates the intent
layer, the cross-repo half is skipped with a logged notice (the LSC-local checks
still run); it activates once contrib pins a core rev carrying `context/`.
