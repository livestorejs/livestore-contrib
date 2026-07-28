# Svelte Integration — Intuition

_For: contributors to `@livestore/svelte` · Assumes: the core integration mental
model (thin bindings over the Store) and Svelte 5 runes · Covers: why Svelte is
one enhanced store instead of a set of hooks_

React has to build its own reactivity to meet the contract: a hook per primitive
(`useStore`, `useQuery`, …), a context-scoped registry to resolve stores, and
reference-counting to survive StrictMode double-invoke and Fast Refresh. Svelte 5
already _has_ a reactive graph — `$effect` tracks its own dependencies and tears
itself down — so the Svelte binding does almost nothing. It boots the store and
then makes one change: it swaps `store.query` for a version that, when you call
it inside a reactive scope, registers a hidden reactive token and subscribes for
you. The store itself becomes the reactive surface; there is no `useQuery`
because `store.query` _is_ the query hook.

The two structural deviations from React both fall out of "lean on Svelte":

- **Lifecycle is the abort signal, not the registry.** React ties store lifetime
  to component lifetime by acquiring through a registry and ref-counting.
  Svelte reads the reactive context's teardown `AbortSignal` and hands it to the
  store, whose scope closes when the signal fires. Same intent — no manual
  shutdown — different machine. The cost: no registry means no sharing, so two
  `createStore` calls in one tree are two independent stores (unlike React's
  scoped resolution).
- **Reactivity is a token trick, not `useSyncExternalStore`.** A per-call empty
  object is added to a reactive `SvelteSet`; reading its membership subscribes
  the effect, and the query's subscription re-adds it on change to force a re-run.

The trap to avoid: because `store.query` looks like it "just works", it is easy
to assume every query type is reactive. It is not — reactivity is wired only for
`def`-tagged query definitions today (`// TODO support other query types`). A
signal-def or a live-query _instance_ used inside `$effect` will render once with
the correct value and then never update. That is the def-only bound (see
LSC.INT.SVELTE-R02 and LSC.INT.SVELTE-DQ1), and it exists because the binding
skips the shared `framework-toolkit` normalization that React relies on.
