# Solid Integration — Intuition

*For: contributors to `@livestore/solid` · Assumes: the core integration mental
model (thin binding over the Store + shared toolkit) and the React integration
as reference · Covers: what changes when the framework is Solid instead of React*

LiveStore's engine already is a fine-grained reactive graph: queries are live,
updates are commit-atomic, results are deduplicated. React fights this — it has
no fine-grained reactivity, so the React binding smuggles values through mutable
refs, forces re-renders, and worries (openly, and still unverified) about tearing
under concurrent rendering. Solid is the opposite: its signals *are* fine-grained
reactivity, so the binding mostly gets out of the way. A query result lives in a
signal, the subscription pushes new values through a `deepEqual` gate, and that is
the whole reactivity story. There is no `useSyncExternalStore` analogue because
there is nothing to reconcile — this is why the Solid binding is a smaller,
calmer realization of the same contract, and why the React binding's tear caveat
simply has no counterpart here.

The one genuinely different shape is **how the store arrives**. React suspends and
`useStore` hands you a loaded store; every query hook downstream can assume it
exists. Solid instead models the store as a `createResource` — an accessor that
reads `undefined` until the promise resolves and integrates with `<Suspense>`.
That single choice ripples outward: the store-attached `useQuery` and
`useClientDocument` must all tolerate an absent store. `useQuery` returns
`undefined` while loading; `useClientDocument` keeps a local buffer signal and
replays any early writes into the real binding the moment the store is ready. This
"optionality branching" — and the still-required client-document default value —
is the binding's least settled part, flagged in the package README as debt to
remove (LSC.INT.SOLID-DQ3); a future Suspense-only path could make the accessors
non-optional and bring the surface back in line with React's.

Two traps to avoid. First: because Solid re-runs *nothing* the way React
StrictMode double-invokes, the reference-counting here looks suspiciously simple —
resist the urge to port React's double-invoke reconciliation; Solid's
`createMemo` + `onCleanup` run once per key by construction (LSC.INT.SOLID-R04).
Second: the surface is *not* at React parity — there is no `useSyncStatus`
(LSC.INT.SOLID-DQ1), multiple concurrent store instances are unproven
(LSC.INT.SOLID-DQ2), and devtools do not work under Solid because the Solid Vite
plugin collides with the React-dependent devtools plugin (LSC.INT.SOLID-DQ4).
Solid earns SSR nearly for free — signals render isomorphically — but that too is
only exercised for the store-attached read path, not server-side store loading.
