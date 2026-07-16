# Svelte Integration — Spec

Specifies the Svelte integration (`packages/@livestore/svelte`) at the
realization-contract level. Builds on [requirements.md](./requirements.md); the
mechanism-agnostic contract and shared toolkit are core
[`08-integrations/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/08-integrations/spec.md).
Citations are `src/…:line` within the package.

## Status

Draft.

## Surface

One export, re-exported from `.` (`src/mod.ts:1`).

| Export | File | Purpose |
| --- | --- | --- |
| `createStore` | `src/create-store.svelte.ts:41` | Async factory: boots a store and returns it with a Svelte-reactive `query` |

There is no hooks surface, no `StoreRegistryContext`, no client-document or
sync-status binding — the entire integration is this one function.

## Store Creation & Lifecycle

`createStore` delegates boot to core `createStorePromise`
(`src/create-store.svelte.ts:51`), spreading the caller's options through
unchanged. Before booting it reads Svelte's teardown `AbortSignal` via
`getAbortSignal()` inside a `try`/`catch` — Svelte throws when called outside a
reactive context, so the signal is best-effort (`:12`, `:46`–`:49`) — and threads
it in only when present (`omitUndefineds({ signal })`, `:53`). Core
`createStorePromise` registers that signal to close the store's `Scope` on
`abort` (core `store/create-store.ts:248`–`254`), so store lifetime follows the
Svelte reactive context without manual shutdown (LSC.INT.SVELTE-R03). Each call
opens a fresh `Scope` and boots an independent store — there is no registry
lookup or cross-call dedup (LSC.INT.SVELTE-DQ2).

## Reactive Query

After boot, `createStore` captures the original `store.query` and **replaces the
method on the returned store instance** (`src/create-store.svelte.ts:58`–`61`) —
the reactivity is a mutation of the returned `Store`, not a wrapper the caller
opts into. The patched `query`:

- Engages reactivity only when the argument is a `def`-tagged live query
  definition **and** the call happens inside a tracking scope
  (`isLiveQueryDef(queryDef) && queryDef._tag === 'def' && $effect.tracking()`,
  `:65`); a `// TODO support other query types` marks the bound (`:64`,
  LSC.INT.SVELTE-DQ1).
- Establishes the reactive dependency through a per-call token in a module
  `SvelteSet<{}>` (`:56`, `:66`): reading `updates.has(token)` (`:70`) subscribes
  the enclosing effect to that token's membership.
- Opens an inner `$effect` (`:74`) that `store.subscribe(queryDef, …)` (`:75`);
  the first (synchronous) callback is skipped via an `initial` flag (`:76`–`:79`)
  so it does not re-emit the value already returned by the read, and every
  subsequent change calls `updates.add(token)` (`:81`) to invalidate the token
  and re-run the outer effect.
- Cleans up by deleting the token and unsubscribing (`:84`–`:87`).

In all cases the call ends by delegating to the captured original
implementation, `originalQuery(queryDef, options)` (`:92`), which returns the
current value synchronously — so non-`def` queries still read correctly, they
simply never re-run.

## Omissions vs. React

No client documents (no `useClientDocument` / LWW write path; core LS.SYS.INT-R06
is out of surface here), no sync-status observation, no reference-counted
resource identity (Svelte has no StrictMode double-invoke to defend against),
and no SSR handling (LSC.INT.SVELTE-DQ3). Cross-framework toolkit primitives
(`normalizeQueryable`, client-document helpers, stack-info) are not consumed; the
binding delegates to `Store.query` directly.
