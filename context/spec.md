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
  devtools/        realize core 02-system/07-devtools/, plus the shared
                   devtools UI and tooling those surfaces are built from
    expo/  react/  vite/  chrome/
  cli/             standalone tool; realizes no core dimension
```

Only `devtools/expo/` and `devtools/chrome/` are *surfaces* in the core sense.
`devtools/react/` is the shared UI (a reusable component kit) and
`devtools/vite/` is the plugin that serves it; neither realizes the surface
contract on its own. They are grouped under `devtools/` rather than given a new
top-level dimension because the three ship as one dependency chain — the
precedent for a non-dimension group is `cli` (see below).

Every contrib package has a node. `cli` realizes no core dimension and lives at
the top level. `graphql` is a query-surface (a new live-query kind), not a
framework binding, so it lives under `query-surfaces/` and refines the core
reactivity contract rather than the integration contract (LSC-DQ1, resolved).

## ID Scheme

Contrib IDs use the `LSC` prefix, mirroring the core style. Contrib IDs never
enter the core namespace table; core contracts are referenced by their `LS.*`
IDs with links (see below).

| Namespace             | Node                      |
| --------------------- | ------------------------- |
| `LSC-*`               | root                      |
| `LSC.ADAPT.NODE-*`    | `adapters/node/`          |
| `LSC.ADAPT.EXPO-*`    | `adapters/expo/`          |
| `LSC.SYNC.ELECTRIC-*` | `sync/electric/`          |
| `LSC.SYNC.S2-*`       | `sync/s2/`                |
| `LSC.INT.SOLID-*`     | `integrations/solid/`     |
| `LSC.INT.SVELTE-*`    | `integrations/svelte/`    |
| `LSC.QS.GQL-*`        | `query-surfaces/graphql/` |
| `LSC.DT.EXPO-*`       | `devtools/expo/`          |
| `LSC.DT.REACT-*`      | `devtools/react/`         |
| `LSC.DT.VITE-*`       | `devtools/vite/`          |
| `LSC.DT.CHROME-*`     | `devtools/chrome/`        |
| `LSC.CLI-*`           | `cli/`                    |

Realization sub-nodes (if any) extend their namespace with one more segment and
live under the parent's directory. IDs are sequential per namespace.

## Distribution Classes (pinned / unpinned)

A contrib-wide distinction that governs which surfaces need negotiated
compatibility. It applies beyond devtools, so it is defined here rather than in
a node.

> An **unpinned surface** is one whose running version is *not determined
> mechanically* by the app's LiveStore dependency resolution.
>
> **Test:** can a LiveStore release change which build of this surface the
> developer is running — through lockfile resolution, bundler output, or a
> per-session fetch — without the developer taking an action outside dependency
> install? If no, it is unpinned.
>
> Documentation instructing users to match versions is **not** a mechanism. A
> surface is unpinned if *any* supported install path is unpinned.

| Surface | Class | Why |
| --- | --- | --- |
| Browser extension (`devtools/chrome/`) | unpinned | Manual install, or store-managed auto-update on the vendor's schedule |
| Expo devtools (`devtools/expo/`) | pinned | npm + lockfile |
| Vite plugin / web channel (`devtools/vite/`) | pinned | npm, same release |

The distinction is the **install path, not the topology**. Expo devtools is
out-of-process, often on a separate device, over a hop-routed webmesh `proxy`
channel — and is still pinned. Any definition keyed on process boundary,
transport, or "runs in a browser" classifies it wrongly and would grant version
tolerance to a surface that ships in lockstep.

Consequence: pinned surfaces are compatible by construction and carry no
version-negotiation obligation. Only unpinned surfaces are governed by the
devtools protocol version handshake (core
[`07-devtools`](https://github.com/livestorejs/livestore/blob/main/context/02-system/07-devtools/spec.md)).

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
