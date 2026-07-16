# GraphQL Integration — Spec

Specifies the GraphQL query surface (`packages/@livestore/graphql`) at the
realization-contract level. Builds on [requirements.md](./requirements.md). The
query-kind contract it realizes is core
[`05-store/01-reactivity/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/05-store/01-reactivity/spec.md);
the framework-integration contract it is filed under (but fits poorly) is core
[`08-integrations/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/spec.md).
Citations are `src/…:line` within the package. The whole surface is one file,
`src/graphql.ts` (296 lines), re-exported from `src/index.ts:1`.

## Status

Draft.

## Entry & Surface

One public function, `queryGraphQL` (`src/graphql.ts:37`), plus the query class
and context types it uses. It takes a `TypedDocumentNode`, a variables value or
a `(get) => variables` thunk, and options `{ label?, map?, deps? }`
(`src/graphql.ts:42-49`), and returns a `LiveQueries.LiveQueryDef<TResultMapped>`
(`:50`) — the exact shape core queries produce, so a GraphQL query is
interchangeable with a db/computed/signal query wherever a `LiveQueryDef` is
consumed (LSC.INT.GQL-R01).

The def's `make` is wrapped in `LiveQueries.withRCMap(hash, …)`
(`:61`) and constructs a `LiveStoreGraphQLQuery` (`:62`); `Equal`/`Hash` are
keyed on the def hash (`:73-78`).

## Live-Query Kind

`LiveStoreGraphQLQuery` extends `LiveQueries.LiveStoreQueryBase` with
`_tag = 'graphql'` (`src/graphql.ts:84-89`) — a first-class live-query kind. It
holds two thunks in the store's reactivity graph
(`ctx.reactivityGraph.deref()`, wired at `:67`):

- **`variableValues$`** (`makeThunk` at `:155`, stored `:163`) — created only
  when `genVariableValues` is a function (`:154-163`); static variables are passed
  through without a thunk (`:164-166`, with a `// TODO don't even create a thunk
  if variables are static` at `:149`).
- **`results$`** (`:169`) — the result thunk. It resolves the current variables
  (`:172-175`), runs the query once (`:176-183`), registers table dependencies
  (`:186-190`), records debug info including the printed document and duration
  (`:192`), and returns the mapped result (`:194`).

`destroy` tears down both thunks and derefs dependency queries
(`src/graphql.ts:266-276`).

## Reactivity — Table-Ref Deps

Reactive parity (LSC.INT.GQL-R02) works by table tracking, not by parsing the
GraphQL document. The query context carries a `queriedTables: Set<string>`
(`src/graphql.ts:12-16`). Before each execution the set is cleared
(`:224`); resolvers add to it as they read tables (the set is handed to
resolvers via the store context — see §Schema & Context). After execution the
live query reads the reactive ref of every queried table
(`store[StoreInternalsSymbol].tableRefs[tableName]`, `:186-190`,
`shouldNeverHappen` if a ref is missing), which is what subscribes the query to
those tables. Any write to a queried table therefore re-runs the query — the
same per-written-table invalidation model core db queries use
(LS.SYS.STORE.RX-R03); granularity is whole-table, not row.

## Synchronous Execution

`queryOnce` (`src/graphql.ts:201`) unpacks schema + context from the store
(§Schema & Context), starts an OTel span `executeGraphQLQuery: {operationName}`
(`:220`) with `graphql.variables` / `graphql.query` attributes (`:221-222`),
sets the active OTel context for resolver tracing (`:226`), and calls
`graphql.executeSync({ document, contextValue, schema, variableValues })`
(`:228-233`) — fully synchronous, no promise (LSC.INT.GQL-R03). It records
execution duration into `executionTimes` (`:254-256`) and returns
`{ result, queriedTables, durationMs }` (`:258-262`).

**Errors crash.** When `executeSync` returns `errors`, the span is marked ERROR
(`:238`), the errors are logged, a `debugger` statement fires (`:246`), and
`shouldNeverHappen(...)` throws (`:247`) — an unrecoverable crash, not a
recoverable query error (LSC.INT.GQL-DQ1).

## Typing & Result Mapping

`TypedDocumentNode<TResult, TVariableValues>` types both results and variables
(`src/graphql.ts:42`, `:92`). The `map` option is normalized once in the
constructor (`:132-147`): `undefined` → identity; a `Schema` →
`Schema.decodeEither`, logging + `shouldNeverHappen` on decode failure
(`:135-144`); a function → used directly (`:145-146`); anything else →
`shouldNeverHappen` (`:147`). This is the typed-result / result-mapping contract
(LSC.INT.GQL-R04; the `map` opt-out mirrors LS.SYS.STORE.RX-R05).

## Cache Identity (hash / deps)

The def `hash` is `LiveQueries.depsToString(options.deps)` when `deps` is given,
else the document's operation name, else `shouldNeverHappen('No document name
found and no deps provided')` (`src/graphql.ts:51-55`). `label` defaults to the
operation name then `'graphql'` (`:56`, `:124`). The hash is the two-level dedup
key and the explicit-deps escape hatch (LSC.INT.GQL-R05).

## Schema & Context

Schema and resolver context are read off the store, not passed to
`queryGraphQL`. `unpackStoreContext` (`src/graphql.ts:279-296`) requires
`store.context.graphql.schema` (a `GraphQLSchema`) and
`store.context.graphql.context` (a `LazyGraphQLContextRef`), throwing
`shouldNeverHappen` if any is absent (`:280-288`). The context ref is lazily
initialized: on first use a `'pending'` ref's `make(store)` is called and the
result cached as `'active'` (`:291-294`). `BaseGraphQLContext` carries the
`queriedTables` set and an optional `otelContext` "Needed by Pothos Otel plugin
for resolver tracing" (`:12-16`).

`GraphQLOptions<TContext>` (`:30-33`) types `{ schema, makeContext: (db:
SqliteDbWrapper, tracer, sessionId) => TContext }` — the intended
schema+context-factory shape — but **no function in this package installs it on
the store**; callers must assemble `store.context.graphql` and the
`LazyGraphQLContextRef` themselves (LSC.INT.GQL-DQ2).

## Not Present

- No use of `@livestore/framework-toolkit` — the package builds directly on
  `@livestore/livestore/internal` `LiveQueries` / `ReactiveGraph`
  (`src/graphql.ts:5`). Core LS.SYS.INT-R02 (shared toolkit) does not apply.
- No store-registry / lifecycle ownership (LS.SYS.INT-R03) — the produced def is
  consumed by whatever binding subscribes to it.
- No tests (`package.json` `"test": "echo 'No tests'"`).
