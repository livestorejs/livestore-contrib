# Node Adapter — Requirements

Role: the Node.js realization of LiveStore's adapter/runtime contract —
persistent (filesystem SQLite) and in-memory variants for servers, CLIs, and
tests.

## Context

Refines the core adapter contract
([`02-system/04-runtime/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime),
notably LS.SYS.RT-R01 topology, LS.SYS.RT-R04 leadership, LS.SYS.RT-R11
boot-progress) and the core determinism requirement (LS-R05). Package:
[`packages/@livestore/adapter-node`](../../../packages/@livestore/adapter-node).

## Requirements

- **LSC.ADAPT.NODE-R01 Contract conformance:** The adapter provides the full
  `ClientSession` surface of the core proxy contract; deviations from the
  web reference realization are stated here, never silent.

## Open Design Questions

- **LSC.ADAPT.NODE-DQ1 Intent capture.** This node is a seed: topology
  (threads vs single process), persistence layout, and leadership semantics
  on Node are not yet captured from the implementation. Blocked on: a
  depth-capture pass over `adapter-node` source.
