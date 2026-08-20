# GraphQL Query Surface — Requirements

Role: a **query-surface** realization — it lets a LiveStore live query be
expressed as a typed GraphQL document whose resolvers read the store's SQLite
state, producing a standard `LiveQueryDef` that composes into the store's
reactive graph like any db, computed, or signal query.

## Context

GraphQL is a **query surface**: it adds a new live-query kind to the store's
reactive graph (core [`05-store/01-reactivity/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/05-store/01-reactivity),
`LS.SYS.STORE.RX-*`), so its core contract is the reactivity / query model and
the `refines:` markers below point there. It is **not** a UI-framework binding —
it adds no framework idioms and uses none of the shared `framework-toolkit` —
which is why it is homed here under `query-surfaces/` rather than
`integrations/`. Package:
[`packages/@livestore/graphql`](../../../packages/@livestore/graphql).
Conformance status lives in the core query-surface registry
([`05-store/01-reactivity/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/05-store/01-reactivity/realizations.md));
the package ships no tests and there is no query-surface conformance suite yet.

## Requirements

- **LSC.QS.GQL-R01 GraphQL as a live-query kind:** `queryGraphQL(document,
variables, options)` returns the same `LiveQueryDef` shape core queries
  produce; its instances are `graphql`-tagged live queries
  (`LiveStoreQueryBase` subclasses) that compose into the store's one reactive
  graph alongside db, computed, and signal queries.
  `refines: LS.SYS.STORE.RX-R02`
- **LSC.QS.GQL-R02 Table-ref reactive parity:** A GraphQL query re-executes
  exactly when a table its resolvers read is written. Resolvers record the
  tables they touch into the query context, and the live query subscribes to
  those tables' reactive refs — no stale reads, no missed updates.
  `refines: LS.SYS.STORE.RX-R01`
- **LSC.QS.GQL-R03 Synchronous resolution over session state:** The document is
  resolved synchronously (`graphql.executeSync`) against the store's SQLite
  state through a resolver-supplied `SqliteDbWrapper`; there is no async
  boundary and no loading state, matching the synchronous-query contract.
  `refines: LS.SYS.STORE-R02`
- **LSC.QS.GQL-R04 Typed documents and result mapping:** Queries are
  `TypedDocumentNode`s, giving fully typed results and variables; an optional
  `map` (a plain function or a `Schema`) post-processes results, and the schema
  form decode-validates them. `refines: LS.SYS.STORE-R08, LS.SYS.STORE.RX-R05`
- **LSC.QS.GQL-R05 Deps-driven cache identity:** The live-query definition hash
  is the document's operation name, or an explicit `deps` key when supplied —
  required when variables are contextual and the operation name is not a stable
  identity. This is the two-level dedup key and the explicit-deps escape hatch.
  `refines: LS.SYS.STORE.RX-R03, LS.SYS.STORE.RX-R04`
- **LSC.QS.GQL-R06 Stateless surface:** The surface holds no data state of its
  own — the schema and resolver context live on the store, results live in the
  reactive graph — so it is a thin layer that adds a query _language_ over the
  session state without adding a store or a data cache. `refines: LS.SYS.STORE.RX-R02`

## Open Design Questions

- **LSC.QS.GQL-DQ1 Query errors crash the store.** A GraphQL execution error
  triggers a `debugger` statement and `shouldNeverHappen` — an unrecoverable
  crash — rather than surfacing a recoverable query error. Whether a failed
  _query_ should be recoverable at the query level (unlike a failed _commit_,
  LS.SYS.STORE-R09) is uncaptured.
- **LSC.QS.GQL-DQ2 No context-wiring helper.** `GraphQLOptions` / `makeContext`
  are exported types, but nothing in the package installs `store.context.graphql`
  or builds the `LazyGraphQLContextRef`; callers hand-assemble that shape.
  Whether the package should own schema/context wiring (a `makeGraphQLContext`
  factory) is open.
- **LSC.QS.GQL-DQ3 No conformance, no tests.** The package ships `"No tests"`
  and there is no shared query-surface conformance suite to certify a new
  live-query kind against (the core query-surface registry lists conformance as
  "no suite yet"). Whether a query surface must prove reactivity / dedup / cutoff
  parity with the built-in kinds is open.
