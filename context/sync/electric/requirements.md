# ElectricSQL Sync Provider — Requirements

Role: the ElectricSQL realization of LiveStore's sync-provider contract —
eventlog ordering and distribution via an Electric sync service.

## Context

Refines the core provider contract
([`02-system/03-sync/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync),
notably LS.SYS.SYNC-R02 provider contract, LS.SYS.SYNC-R05 pagination
signal, LS.SYS.SYNC-R06 provider-opaque cursor). Package:
[`packages/@livestore/sync-electric`](../../../packages/@livestore/sync-electric).
Not yet exercised by the core conformance matrix (see the core
`03-sync/realizations.md` registry).

## Requirements

- **LSC.SYNC.ELECTRIC-R01 Contract conformance:** The provider implements
  the core `SyncBackend` interface with total-order arbitration semantics
  equivalent to the reference realization; deviations are stated here,
  never silent.

## Open Design Questions

- **LSC.SYNC.ELECTRIC-DQ1 Intent capture.** This node is a seed: ordering
  mechanics on Electric, cursor/metadata shape, liveness model, and limits
  are not yet captured. Blocked on: a depth-capture pass over
  `sync-electric` source.
