# DELTA-002 — The React viewer is replay-only

Status: open

The viewer loads completed artifacts and projects their topology, semantic
records, calibrated timing, captures, failures, and explicit causal edges. It
cannot stream an active run, issue capability-scoped runner controls, pause at
a declared scheduling boundary, or save a live session as an ordinary artifact.

Closing this gap requires a versioned incremental trace/run-state transport and
an explicit runner control API. Headless execution remains authoritative, live
controls may use only declared scheduling boundaries, and a captured session
must remain loadable through the ordinary artifact decoder.

VRS: LSC.VER.SCEN-R06.
