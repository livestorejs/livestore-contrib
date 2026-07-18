# Solid Integration — Requirements

Role: the SolidJS realization of LiveStore's framework-integration contract —
a thin binding that surfaces stores and live queries as Solid signals,
resources, and memos, with registry-based lifecycle. Experimental and unstable
(package README).

## Context

Refines the core framework-integration contract
([`02-system/08-integrations/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/08-integrations),
`LS.SYS.INT-*`) and its shared toolkit
(`packages/@livestore/framework-toolkit`). Package:
[`packages/@livestore/solid`](../../../packages/@livestore/solid). The React
integration
([core `08-integrations/01-react/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/08-integrations/01-react),
`LS.SYS.INT.REACT-*`) is the reference realization; Solid replaces React's
hooks / refs / `useSyncStatus` / Suspense-return model with fine-grained
signals, a `createResource` store handle, and `onCleanup` disposal, so the
surface shape, reactivity bridge, and store-loading model deviate — those
deviations are stated here, never silent. Conformance status lives in the core
integration registry
([`08-integrations/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/realizations.md));
the realization-independent binding conformance suite is contracted but unbuilt
(core LS.SYS.VER.CONF-R04).

## Requirements

- **LSC.INT.SOLID-R01 Signal-based surface:** The integration exposes
  `useStore`, a `StoreRegistryProvider` / `useStoreRegistry` pair, and — attached
  to the loaded store by `withSolidApi` — `useQuery` and `useClientDocument`
  (plus an experimental `LiveList` component). Every rendered value is a Solid
  accessor (signal / memo / resource), not a React hook return; components never
  touch session or leader internals. `useSyncStatus` is **not** exposed (the
  React surface has it — LSC.INT.SOLID-DQ1). `refines: LS.SYS.INT-R01`
- **LSC.INT.SOLID-R02 Context-scoped registry:** Stores resolve through a Solid
  `StoreRegistryContext`; `StoreRegistryProvider` scopes which stores a subtree
  sees, and `useStoreRegistry` throws outside a provider (or takes an explicit
  override for advanced preloading). `refines: LS.SYS.INT-R03`
- **LSC.INT.SOLID-R03 Fine-grained reactive bridging:** A query's result is held
  in a Solid signal, seeded by a synchronous first read, updated on subscription
  with a `deepEqual` dedup gate, and disposed via `onCleanup`. No
  `useSyncExternalStore`-style tear guard is needed: Solid's fine-grained
  reactivity delivers commit-atomic updates without the concurrent-rendering
  tear concern that the React binding flags as unverified. `refines: LS.SYS.INT-R04`
- **LSC.INT.SOLID-R04 Single-pass resource lifecycle:** Store acquisition retains
  through the registry inside a `createResource` fetcher and releases on
  `onCleanup`; each query's reference-counted `rcRef` is created and `deref`'d
  exactly once per key. Solid has no StrictMode-style double invocation, so this
  reference-counting is structurally simpler than React's double-invoke
  reconciliation. `refines: LS.SYS.INT-R03, LS.SYS.INT-R05`
- **LSC.INT.SOLID-R05 Store-optionality bridging:** Because `useStore` returns a
  `createResource` handle that is `undefined` until the store loads, the
  store-attached API tolerates a not-yet-loaded store: `useQuery` returns
  `undefined` while loading and `useClientDocument` buffers writes into a local
  signal, flushing them once the store is ready. This is Solid's substitute for
  React's suspend-then-return model. `refines: LS.SYS.INT-R05`
- **LSC.INT.SOLID-R06 Isomorphic server rendering:** Signals render on the server
  (`solid-js/web` `renderToString`, `isServer`); `withSolidApi` wraps a
  pre-created store so a component's synchronous first read materializes into the
  SSR output. `refines: LS.SYS.INT-R04`

## Open Design Questions

- **LSC.INT.SOLID-DQ1 No `useSyncStatus`.** The React surface exposes
  `useSyncStatus` (core LS.SYS.INT.REACT-R01); the Solid surface does not.
  Whether Solid should expose an equivalent sync/network-status accessor is
  uncaptured.
- **LSC.INT.SOLID-DQ2 Single concurrent store instance.** Support for multiple
  concurrent store instances is listed as an open task (package README); the
  registry model admits it but the Solid binding has not been exercised for it.
- **LSC.INT.SOLID-DQ3 Store-optionality ergonomics.** The `undefined`-while-
  loading branching and the still-required client-document default value are
  flagged as tech debt to remove (package README); whether a Suspense-only path
  (mirroring React's return-loaded-store model) should replace the optional
  accessors is open, and interacts with LSC.INT.SOLID-R05.
- **LSC.INT.SOLID-DQ4 Devtools under Solid.** LiveStore devtools do not work with
  Solid: the Solid Vite plugin conflicts with the React-dependent LiveStore
  devtools Vite plugin (package README). The resolution (devtools UI decoupled
  from React, or a Solid-compatible transport) is uncaptured.
