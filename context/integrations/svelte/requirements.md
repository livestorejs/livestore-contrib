# Svelte Integration — Requirements

Role: the Svelte realization of LiveStore's framework-integration contract — a
single `createStore` factory that returns a `Store` whose `query` method is
wired into Svelte 5's reactive graph (runes), so `$effect`/derived blocks re-run
when query results change.

## Context

Refines the core framework-integration contract
([`02-system/08-integrations/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/08-integrations),
`LS.SYS.INT-*`). Package:
[`packages/@livestore/svelte`](../../../packages/@livestore/svelte). The React
integration
([core `08-integrations/01-react/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/08-integrations/01-react),
`LS.SYS.INT.REACT-*`) is the reference realization; Svelte replaces React's
hooks + context-scoped registry + reference-counting with a single enhanced
store and Svelte's own `$effect`/abort-signal machinery, so its surface,
reactivity mechanism, and lifecycle deviate — those deviations are stated here,
never silent. Unlike React, the binding consumes **none** of the shared
`framework-toolkit` (no `normalizeQueryable`, no client-document helpers); it
delegates directly to `Store.query`, which bounds its reactive coverage
(LSC.INT.SVELTE-R02). Conformance status lives in the core integration registry
([`08-integrations/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/realizations.md)),
whose Svelte row already points at this node; the realization-independent
binding conformance suite is contracted but unbuilt (core LS.SYS.VER.CONF-R04).

## Requirements

- **LSC.INT.SVELTE-R01 Single async factory, no hooks:** The integration exposes
  exactly one member, `createStore` — an async factory that boots a store and
  returns it with a Svelte-reactive `query`. There are no per-primitive hooks
  and no client-document or sync-status surface (contrast React's
  `useStore`/`useQuery`/`useClientDocument`/`useSyncStatus`,
  LS.SYS.INT.REACT-R01); the binding holds no data state and adds no query
  semantics of its own. `refines: LS.SYS.INT-R01`
- **LSC.INT.SVELTE-R02 Reactive parity via a patched `query`, bounded to `def`
  queries:** Rather than a query hook, `createStore` patches the returned store's
  `query` method so that, when called inside a tracking reactive scope, it
  subscribes to the query and invalidates a reactive token on change, re-running
  the enclosing `$effect`/derived with a fresh, deduplicated-by-construction
  read. Reactive wiring is currently established **only** for `def`-tagged live
  query definitions; signal-defs and live `LiveQuery` instances fall through to a
  one-shot read and receive no updates — a stated coverage bound, see
  LSC.INT.SVELTE-DQ1. `refines: LS.SYS.INT-R04`
- **LSC.INT.SVELTE-R03 Lifecycle via the Svelte abort signal, not the registry:**
  Store lifetime follows the Svelte reactive context: `createStore` reads
  Svelte's teardown `AbortSignal` (when present) and threads it into store
  creation, so the store's scope closes on teardown without manual shutdown.
  This realizes the lifecycle intent of the core requirement through Svelte's
  own lifecycle rather than the store registry; consequently there is no
  registry-scoped sharing or deduplication (the React realization's
  LS.SYS.INT.REACT-R02) — each call boots an independent store, see
  LSC.INT.SVELTE-DQ2. `refines: LS.SYS.INT-R03`
- **LSC.INT.SVELTE-R04 Robust under Svelte reactive semantics:** The binding
  tolerates Svelte's re-run and teardown model without leaking or
  double-emitting: reactive work is gated on `$effect.tracking()`, the first
  (synchronous) subscription callback is skipped so it does not double-count the
  initial read, and effect cleanup both unsubscribes and drops the reactive
  token. `refines: LS.SYS.INT-R05`

## Open Design Questions

- **LSC.INT.SVELTE-DQ1 Query-type coverage.** Reactivity is wired only for
  `_tag === 'def'` queries (`// TODO support other query types`); whether the
  binding should cover all queryables — as the shared toolkit's
  `normalizeQueryable` does for React — is open. Until then, signal-def and
  live-instance queries used inside `$effect` render stale.
- **LSC.INT.SVELTE-DQ2 Store sharing/scoping.** Each `createStore` call boots a
  fresh store; unlike React's context-scoped registry, two calls in one
  component tree yield two independent stores. Whether Svelte should offer
  registry-style sharing/scoping is uncaptured.
- **LSC.INT.SVELTE-DQ3 SSR.** There is no SSR handling; the top-level-`await
  createStore` usage pattern's behavior under SvelteKit server rendering
  (client-only WASM adapter, abort-signal availability) is uncaptured.
