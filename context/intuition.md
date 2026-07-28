# LiveStore Contrib — Intent Layer

_For: contributors to livestore-contrib · Assumes: familiarity with
[LiveStore's intent layer](https://github.com/livestorejs/livestore/tree/main/context)
· Covers: how this repo's realization intent relates to the core contracts_

This repository hosts realization intent for contrib-owned packages. The
product intent layer — vision, requirements, subsystem contracts, ontology —
lives in `livestorejs/livestore` under `context/`; nothing here restates it.

Each node in this tree describes one contrib realization of a core pluggable
dimension (platform adapters, sync providers, framework integrations,
devtools surfaces). A realization node cites the core contract it refines by
`LS.*` requirement ID and link, and owns only what is specific to its
realization: platform constraints, deviations, maturity, and open questions.

The core side lists every realization (in-repo and contrib) in per-dimension
`realizations.md` registries; the referencing mechanism is core decision
[0003-contrib-referencing](https://github.com/livestorejs/livestore/blob/main/context/.decisions/0003-contrib-referencing.md).
