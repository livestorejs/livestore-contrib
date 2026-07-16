# Solid Integration — Spec

Specifies the Solid integration (`packages/@livestore/solid`) at the
realization-contract level. Builds on [requirements.md](./requirements.md); the
mechanism-agnostic contract and shared toolkit are core
[`08-integrations/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/spec.md),
and the reference realization is core
[`08-integrations/01-react/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/01-react/spec.md).
Citations are `src/…:line` within the package.

## Status

Draft.

## Surface

Exported from `.` (`src/mod.ts`):

| Export | File | Purpose |
| --- | --- | --- |
| `useStore` | `useStore.ts:105` | Acquire a store as a Solid `Resource` (undefined until loaded), augmented with Solid API |
| `withSolidApi` | `useStore.ts:135` | Attach `useQuery` / `useClientDocument` to a store (or store accessor) |
| `StoreRegistryProvider` / `useStoreRegistry` | `StoreRegistryContext.tsx:36`, `:61` | Scope store resolution per subtree |
| `useQuery` (standalone) | `useQuery.ts:28` | Subscribe to any queryable given an explicit `{ store }` |
| `useClientDocument` (standalone) | `useClientDocument.ts:90` | Read/update a client document given an explicit `{ store }` |
| `LiveList` (experimental) | `experimental/components/LiveList.tsx:32` | Per-item live-query list; API unstable |

The standalone `useQuery` / `useClientDocument` require an explicit `store`
option; the ergonomic surface is the store-attached form
`store()?.useQuery(def)` produced by `withSolidApi` (`src/useStore.ts:139`,
`:144`). No `useSyncStatus` is exported (`src/mod.ts`; LSC.INT.SOLID-DQ1).

## Reactivity Bridge

`useQueryRef` (`src/useQuery.ts:35`) is the core bridge. It normalizes the
queryable through the shared toolkit (`normalizeQueryable`, `:50`), computes the
resource-cache key (`computeRcRefKey`, `:54`), and captures stack info for
provenance (`captureStackInfo`, `:56`). A `createMemo` keyed on the rc-ref key
(`Solid.on(rcRefKey)`, `:58`) builds the query resource (`createQueryResource`,
`:62`), seeds a signal with the synchronous first read (`runInitialQuery(…,
'solid')`, `:67`), then `store.subscribe`s (`:77`) with a `deepEqual` gate
before `setValueRef` so identical results never re-render (`:83`). Disposal runs
in `Solid.onCleanup` — `queryRcRef.deref()`, span end, unsubscribe (`:96`).
Renders read the signal via `valueRef` (`:107`). Unlike the React binding, no
`useSyncExternalStore` substitute is needed: Solid's fine-grained tracking makes
each subscription push its own consistent update (LSC.INT.SOLID-R03).

## Store Acquisition & Optionality

`useStore` (`src/useStore.ts:105`) resolves the registry from context
(`:112`) and wraps `storeRegistry.getOrLoadPromise` in a `createResource` whose
source is the resolved options (`:114`). The fetcher retains the store
(`storeRegistry.retain(opts)`, `:117`) and registers its release on `onCleanup`
(`:118`), so store lifetime follows component lifetime (LS.SYS.INT-R03). The
resource is a Solid `Resource<Store>` that reads `undefined` until loaded and
integrates with `<Suspense>` (docstring `:66`–`:104`).

`withSolidApi` (`:135`) `Object.assign`s the Solid API onto the store or store
accessor. Because the accessor may be `undefined`, both methods bridge the
optional store with `when` / `every` (from `src/whenever.ts:42`, `:68`, inlined
from `solid-whenever`):

- **`useQuery`** (`:139`) runs the standalone `useQuery` inside a `createMemo`
  gated by `when(store, …)`; the returned accessor yields `undefined` while the
  store is loading, else the live value.
- **`useClientDocument`** (`:144`) keeps a local buffer signal (`:145`). A
  `createMemo` gated by `every(store, table)` (`:147`) builds the real
  client-document binding once both are present and flushes any buffered write
  into it (`:153`). Until then, `state` reads the local buffer and `setState`
  writes it (`:164`, `:167`) — writes issued before load are not lost
  (LSC.INT.SOLID-R05). The README flags this optionality branching, and the
  still-required default value, as tech debt (LSC.INT.SOLID-DQ3).

`AccessorMaybe<T>` (`src/utils.ts:5`) lets every parameter be a value or a
reactive accessor; `resolve` unwraps it.

## Write Path (`useClientDocument`)

The standalone `useClientDocument` (`src/useClientDocument.ts:90`) validates the
table via the shared toolkit inside a `createComputed`
(`validateTableOptions`, `:108`), derives the row query with `queryDb(table.get(
id, { default }))` memoized on `[serializedId, tableName, default]` (`:111`),
and subscribes via `useQueryRef` (`:127`). `setState` resolves functional
updates against the current signal value (`:137`), short-circuits on reference
equality (`===`, `:139`), then commits one client-only LWW event
`store.commit(table.set(removeUndefinedValues(value), id))` (`:141`) — no
debouncing. The default row is seeded by the shared `table.get(…, { default })`
read path (core LS.SYS.INT-R06); the binding adds no separate seeding step.
Returns `[state, setState, id, query$]` accessors (`:144`).

## Registry Context

`StoreRegistryContext` is a Solid context defaulting to `undefined`
(`src/StoreRegistryContext.tsx:4`). `StoreRegistryProvider` supplies a
`StoreRegistry` to descendants (`:36`); `useStoreRegistry` returns it, accepts an
explicit `override` to skip context lookup (advanced preloading), and throws when
called outside a provider (`:61`, `:66`). This realizes context-scoped lifecycle
ownership (LSC.INT.SOLID-R02).

## Server Rendering

Signals render isomorphically. Under `solid-js/web`'s SSR transform, `isServer`
is true and `renderToString` produces markup with no `window`
(`src/useStore.server.test.tsx:16`–`22`, `:40`). `withSolidApi` wraps a
pre-created in-memory store (`:34`), and a store-attached `useClientDocument`
read renders server-side (`:58`, `useClientDocument.server.test.tsx`). SSR
covers the store-attached read path; store *loading* on the server is out of
scope for the current tests (LSC.INT.SOLID-R06).

## Experimental — LiveList

`LiveList` (`src/experimental/components/LiveList.tsx:32`) moves reactivity to the
item level: it derives a live query of item keys, renders a `Solid.For`, and each
`ItemWrapper` runs its own per-item `useQuery` (`:41`–`:52`) so a single item
change re-renders only that node. Incremental / animated rendering is a
documented TODO (`:8`–`:12`). API unstable.
