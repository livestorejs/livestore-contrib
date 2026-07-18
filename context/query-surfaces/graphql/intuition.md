# GraphQL Query Surface — Intuition

*For: contributors to `@livestore/graphql` · Assumes: the core reactive query
model (live queries composing into one incremental graph, core
[`05-store/01-reactivity/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/05-store/01-reactivity))
· Covers: why GraphQL is a query *kind*, not a framework binding*

## It's a query surface, not a framework binding

The framework bindings — Solid, Svelte, under `integrations/` — translate one
store into a framework's native reactive values and own nothing else. GraphQL is
a different animal. It doesn't bind the store to a framework; it adds a new **way
to write a query**. `queryGraphQL` gives you back exactly what `queryDb` gives
you — a `LiveQueryDef` — so the GraphQL query drops into the same reactive graph
and is consumed by the same React/Solid hooks. The store doesn't know or care
that this particular live query happens to run resolvers. That is why it is homed
here under `query-surfaces/`, refining the reactivity contract (it adds a new
live-query kind), not the framework-integration one.

## The trick: reactivity by observing what resolvers touch

The engine can't diff a GraphQL document to know which tables matter. So the
package inverts it: resolvers query the store's SQLite through a shared context,
and each read drops the table name into a `queriedTables` set. After execution
the live query subscribes to exactly those tables' reactive refs. Write to a
table a resolver read → the whole query re-runs. It is the same
per-written-table invalidation core db queries use — coarse (whole-table, not
row), but glitch-free and identical in spirit to the rest of the graph.

## Where the schema and resolvers live

Nothing about the schema is passed to `queryGraphQL`. The schema and a lazily
built resolver context hang off `store.context.graphql`; the query unpacks them
at execution time. This keeps the query call site tiny (just a document + vars),
but it also means the package stops at the query boundary — it never wires that
context onto the store for you, and it has no opinion on store lifecycle. If you
came looking for a `makeGraphQLContext`, it isn't here yet (DQ2).

## The sharp edge: a query error is fatal

Unlike a normal query that could return an empty or partial result, a GraphQL
execution error here hits a `debugger` and throws `shouldNeverHappen` — it takes
the process down. Treat GraphQL errors as programmer errors (bad schema, bad
resolver), not as data conditions to handle, until DQ1 is settled. Combined with
the missing conformance suite and zero tests, this is early, sharp-edged code —
useful as a query surface, not yet a hardened one.
