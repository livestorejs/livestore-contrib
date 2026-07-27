# LiveStore Contrib — Open Questions

Contrib-wide questions only. Node-local design questions live in each node's
`requirements.md` (`LSC.*-DQ*`); confirmed divergences from a core contract live
in that node's `.delta/`.

- **LSC-DQ2 Mixed licensing in contrib.** Contrib is Apache-2.0 today (root `LICENSE`,
  and every package inherits `license: 'Apache-2.0'` from the shared genie defaults).
  The incoming devtools packages ship under a size-gated source-available licence, so
  contrib becomes a mixed-licence repository. Unresolved: whether the split is permanent
  or an intermediate state, how per-package licences are declared and *validated*
  (nothing checks the `license` field today), and whether a component-kit subset of
  `devtools-react` stays permissive. Tracked in
  [livestorejs/livestore#1497](https://github.com/livestorejs/livestore/issues/1497);
  the governing decision is core's, not contrib's.

(LSC-DQ1 GraphQL node placement was resolved 2026-07-17: query surfaces became a
first-class realization dimension and `graphql` moved to `query-surfaces/`,
refining the core reactivity contract — see core
[decision 0005](https://github.com/livestorejs/livestore/blob/main/context/.decisions/0005-query-surface-dimension.md).)
