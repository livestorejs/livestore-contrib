# DELTA-001 — Scenario surface and oracle coverage remain incomplete

Status: open

The current AST does not retain rematerialization operations. Workloads do not
yet express rates, stop conditions, generated parallel scheduling, or nesting.
The oracle catalogue does not provide portable rematerialization equivalence,
resource-bound, or performance verdicts, and failure artifacts are preserved
without automatic minimization.

Add surface area only for a concrete Scenario. New variants require stable
serializable instructions/outcomes, capability derivation, and evidence-aware
oracles that reject missing prerequisites. Performance verdicts must use
wall-clock evidence and remain distinct from logical time.

VRS: LSC.VER.SCEN-R03, LSC.VER.SCEN-R05; core
LS.SYS.VER.SCEN-R04, LS.SYS.VER.SCEN-R14, LS.SYS.VER.SCEN-DQ1,
LS.SYS.VER.SCEN-DQ3.
