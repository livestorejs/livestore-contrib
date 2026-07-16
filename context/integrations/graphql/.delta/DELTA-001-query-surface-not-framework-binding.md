# DELTA-001 — GraphQL is a query surface, not a framework binding

Status: open

The core framework-integration contract requires an integration to be a thin,
stateless wrapper that adapts Store primitives to a UI framework's idioms and
**adds no query semantics** (core LS.SYS.INT-R01), sharing the cross-framework
`framework-toolkit` (LS.SYS.INT-R02), owning store lifecycle through the registry
(LS.SYS.INT-R03), and being robust under a framework's rendering model
(LS.SYS.INT-R05). `@livestore/graphql` is filed under this dimension — the core
registry lists it as a "query-surface integration"
([`08-integrations/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/realizations.md))
— but it meets almost none of that contract:

- It **adds a query language** (GraphQL) as an alternative surface — the direct
  opposite of the "add no query semantics" clause (`src/graphql.ts:37`, `:228`).
- It uses **none** of `framework-toolkit`; it builds on
  `@livestore/livestore/internal` `LiveQueries` / `ReactiveGraph` directly
  (`src/graphql.ts:5`). LS.SYS.INT-R02 does not apply.
- It touches **no store registry** and owns no lifecycle — it emits a
  `LiveQueryDef` (`src/graphql.ts:50`) consumed by whatever binding subscribes.
  LS.SYS.INT-R03 does not apply.
- It has **no framework rendering model** — the def is framework-agnostic.
  LS.SYS.INT-R05 does not apply.

What it *does* satisfy is reactive parity (LS.SYS.INT-R04) — and that obligation
is itself a restatement of the reactivity contract LS.SYS.STORE.RX-R01. The
package's real nature is a new **live-query kind** (`_tag = 'graphql'`,
`src/graphql.ts:89`) composing into the store's reactive graph
(LS.SYS.STORE.RX-R02); its honest core anchor is
[`05-store/01-reactivity/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/05-store/01-reactivity),
which is where the `LSC.INT.GQL-*` requirements mostly `refines:`.

This is a **fundamental fit mismatch, not a limitation to be fixed**: GraphQL is
a different kind of thing from a framework binding.

Close condition: either the node is re-homed under the reactivity / query-model
dimension (with the registry link moved accordingly), or the core intent layer
introduces a "query-surface" category distinct from framework bindings and
LSC.INT.GQL-R06 is restated as a conformant realization of it. Until then this
node stays under `integrations/` to match the core registry, and the mismatch is
carried here rather than silently absorbed.
