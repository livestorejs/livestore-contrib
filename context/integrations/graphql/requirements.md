# GraphQL Integration — Requirements

Role: a **query-surface** realization, not a framework binding — it lets a
LiveStore live query be expressed as a typed GraphQL document whose resolvers
read the store's SQLite state, producing a standard `LiveQueryDef` that composes
into the store's reactive graph like any db, computed, or signal query.

## Context

This node is filed under the framework-integration dimension
([`02-system/08-integrations/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/08-integrations),
`LS.SYS.INT-*`) because the core registry parks it there as a "query-surface
integration"
([`08-integrations/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/realizations.md)).
That home fits poorly: GraphQL is **not** a UI-framework binding. It adds no
framework idioms, uses none of the shared `framework-toolkit` (LS.SYS.INT-R02),
touches no store registry (LS.SYS.INT-R03), and has no framework rendering model
to be robust under (LS.SYS.INT-R05). What it actually does is add a new
**live-query kind** to the reactive graph, so its genuine core anchor is the
reactivity / query model
([`05-store/01-reactivity/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/05-store/01-reactivity),
`LS.SYS.STORE.RX-*`) — most `refines:` below point there. The one
framework-integration obligation it does meet is reactive parity
(LS.SYS.INT-R04), which is itself a restatement of LS.SYS.STORE.RX-R01. The
placement/contract mismatch is recorded in
[.delta/DELTA-001](./.delta/DELTA-001-query-surface-not-framework-binding.md).

Package:
[`packages/@livestore/graphql`](../../../packages/@livestore/graphql). Conformance
status lives in the core integration registry
([`08-integrations/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/realizations.md),
row `—`); the package ships no tests and participates in no conformance suite.

## Requirements

- **LSC.INT.GQL-R01 GraphQL as a live-query kind:** `queryGraphQL(document,
  variables, options)` returns the same `LiveQueryDef` shape core queries
  produce; its instances are `graphql`-tagged live queries
  (`LiveStoreQueryBase` subclasses) that compose into the store's one reactive
  graph alongside db, computed, and signal queries.
  `refines: LS.SYS.STORE.RX-R02`
- **LSC.INT.GQL-R02 Table-ref reactive parity:** A GraphQL query re-executes
  exactly when a table its resolvers read is written. Resolvers record the
  tables they touch into the query context, and the live query subscribes to
  those tables' reactive refs — no stale reads, no missed updates.
  `refines: LS.SYS.STORE.RX-R01, LS.SYS.INT-R04`
- **LSC.INT.GQL-R03 Synchronous resolution over session state:** The document is
  resolved synchronously (`graphql.executeSync`) against the store's SQLite
  state through a resolver-supplied `SqliteDbWrapper`; there is no async
  boundary and no loading state, matching the synchronous-query contract.
  `refines: LS.SYS.STORE-R02`
- **LSC.INT.GQL-R04 Typed documents and result mapping:** Queries are
  `TypedDocumentNode`s, giving fully typed results and variables; an optional
  `map` (a plain function or a `Schema`) post-processes results, and the schema
  form decode-validates them. `refines: LS.SYS.STORE-R08, LS.SYS.STORE.RX-R05`
- **LSC.INT.GQL-R05 Deps-driven cache identity:** The live-query definition hash
  is the document's operation name, or an explicit `deps` key when supplied —
  required when variables are contextual and the operation name is not a stable
  identity. This is the two-level dedup key and the explicit-deps escape hatch.
  `refines: LS.SYS.STORE.RX-R03, LS.SYS.STORE.RX-R04`
- **LSC.INT.GQL-R06 Stateless surface that nonetheless adds a query language:**
  The binding holds no data state of its own — the schema and resolver context
  live on the store, results live in the reactive graph — satisfying the
  "no data state" half of the thin-wrapper contract. But it **does** add a query
  language as an alternative surface, contradicting the "add no query semantics"
  half; that deviation is the reason 08-integrations is a poor home
  ([.delta/DELTA-001](./.delta/DELTA-001-query-surface-not-framework-binding.md)).
  `refines: LS.SYS.INT-R01`

## Open Design Questions

- **LSC.INT.GQL-DQ1 Query errors crash the store.** A GraphQL execution error
  triggers a `debugger` statement and `shouldNeverHappen` — an unrecoverable
  crash — rather than surfacing a recoverable query error. Whether a failed
  *query* should be recoverable at the query level (unlike a failed *commit*,
  LS.SYS.STORE-R09) is uncaptured.
- **LSC.INT.GQL-DQ2 No context-wiring helper.** `GraphQLOptions` / `makeContext`
  are exported types, but nothing in the package installs `store.context.graphql`
  or builds the `LazyGraphQLContextRef`; callers hand-assemble that shape.
  Whether the package should own schema/context wiring (a `makeGraphQLContext`
  factory) is open.
- **LSC.INT.GQL-DQ3 No conformance, no tests.** The package ships `"No tests"`
  and has no query-kind or integration conformance coverage (registry row `—`).
  There is no shared "live-query kind" conformance suite to certify a new kind
  against — cf. the still-unbuilt binding suite (LS.SYS.INT-DQ1).
