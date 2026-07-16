# LiveStore Contrib — Open Questions

Contrib-wide questions only. Node-local design questions live in each node's
`requirements.md` (`LSC.*-DQ*`); confirmed divergences from a core contract live
in that node's `.delta/`.

- **LSC-DQ1 GraphQL node placement.** `graphql` is hosted under
  `integrations/` (per the contrib node layout and the core integrations
  registry), but it is a query-*surface*, not a framework binding — it adds a
  live-query kind to the reactive graph rather than realizing the
  framework-integration contract. Its honest home is the core query/reactivity
  model (`05-store/01-reactivity/`). Tracked as
  [`integrations/graphql/.delta/DELTA-001`](./integrations/graphql/.delta/DELTA-001-query-surface-not-framework-binding.md);
  resolved by either re-homing it or adding a core "query-surface" category.
