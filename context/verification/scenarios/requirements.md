# Scenario Verification Realization — Requirements

Role: the private contrib realization of LiveStore's mechanism-independent
Scenario verification contract: runner, participant hosts, backend profiles,
corpus, artifacts, and React viewer.

## Context

Refines the canonical core Scenario contract
([`02-system/09-verification/06-scenarios/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/09-verification/06-scenarios),
`LS.SYS.VER.SCEN-*`). The implementation is the private
[`@local/tests-scenarios`](../../../tests/scenarios) workspace. Core owns the
portable terminology and evidence contract; this node owns the concrete
realization choices and gaps, as registered by core
[decision 0003](https://github.com/livestorejs/livestore/blob/main/context/02-system/09-verification/06-scenarios/.decisions/0003-contrib-runner-viewer-realization.md).

## Requirements

- **LSC.VER.SCEN-R01 One private verification workspace:** The runner, model,
  hosts, backend realizations, corpus, CLI, artifacts, React viewer, Storybook,
  and parity tests stay in one private `tests/scenarios/` workspace. It may
  depend on materialized core packages, but is never part of the product
  publish surface and no core package depends on it.
  `refines: LS.SYS.VER.SCEN-R18`
- **LSC.VER.SCEN-R02 Three participant profiles with explicit backend
  composition:** The realization provides in-process, isolated Node process,
  and persistent Chromium participant profiles. The in-process profile can use
  the controlled `makeMockSyncBackend`; process and browser evidence use a
  local real `sync-cf` Worker and Durable Object behind a Scenario-owned
  availability proxy. Each composition advertises only the controls and
  evidence it actually supplies. `refines: LS.SYS.VER.SCEN-R05, LS.SYS.VER.SCEN-R06, LS.SYS.VER.SCEN-R07, LS.SYS.VER.SCEN-R08, LS.SYS.VER.SCEN-R11`
- **LSC.VER.SCEN-R03 One portable model and corpus across profiles:** Typed
  Application definitions, versioned Scenario ASTs, named actions, seeded
  Workloads, topology/lifecycle steps, and preflight capability derivation are
  shared without profile-specific Scenario rewrites. Generated actions retain
  stable operation identity and deterministic seed derivation.
  `refines: LS.SYS.VER.SCEN-R01, LS.SYS.VER.SCEN-R02, LS.SYS.VER.SCEN-R03, LS.SYS.VER.SCEN-R04, LS.SYS.VER.SCEN-R09`
- **LSC.VER.SCEN-R04 Shared host conformance and bounded settlement:** Every
  implemented profile runs the same capability-parameterized host suite.
  Control acknowledgements, failure category, outcome certainty, sampled
  observations, recovery evidence, and terminal Settlement remain distinct;
  snapshot oracles require a terminal Settlement covering their participants.
  `refines: LS.SYS.VER.SCEN-R05, LS.SYS.VER.SCEN-R08, LS.SYS.VER.SCEN-R12, LS.SYS.VER.SCEN-R15, LS.SYS.VER.SCEN-R21`
- **LSC.VER.SCEN-R05 Replayable artifacts and current oracle catalogue:** Runs
  retain normalized input, execution identity, seed, semantic trace, sampled
  system observations, operation outcomes, verdicts, and failure evidence.
  Current portable coverage includes Eventlog equality, sampled confirmed
  prefixes, pending resolution, State convergence, expected application
  effects, operation history, and bounded recovery/Settlement; unsupported
  evidence is rejected rather than inferred.
  `refines: LS.SYS.VER.SCEN-R13, LS.SYS.VER.SCEN-R14, LS.SYS.VER.SCEN-R15, LS.SYS.VER.SCEN-R16, LS.SYS.VER.SCEN-R19, LS.SYS.VER.SCEN-R21`
- **LSC.VER.SCEN-R06 React replay viewer with parity evidence:** The canonical
  viewer is a React application over immutable run artifacts, with causal-flow
  and elapsed-time projections, topology, playback, raw record inspection,
  Storybook state fixtures, and Playwright screenshot/interaction parity. It
  never inspects or mutates participants directly; headless execution remains
  authoritative. `refines: LS.SYS.VER.SCEN-R17, LS.SYS.VER.SCEN-R20`
- **LSC.VER.SCEN-R07 Explicit local and CI verification surface:** Generated
  workspace and TypeScript composition register `tests/scenarios`; devenv
  provides runner, viewer, Storybook, build, and parity tasks with pinned
  browser support; CI has a dedicated required Scenario job covering the
  runner suites and both viewer builds/parity. `refines: LS.SYS.VER.SCEN-R17, LS.SYS.VER.SCEN-R18`

## Open Design Questions

- **LSC.VER.SCEN-DQ1 Failure minimization realization.** Core
  LS.SYS.VER.SCEN-DQ1 remains open; the current CLI preserves failures but does
  not shrink a generated workload or fault schedule. The dependency-aware
  reduction approach and first campaign are specified in
  [`tests/scenarios/RED_TEAMING.md`](../../../tests/scenarios/RED_TEAMING.md).
- **LSC.VER.SCEN-DQ2 Trace retention realization.** Core
  LS.SYS.VER.SCEN-DQ2 remains open; tracked references use compressed complete
  artifacts, with no sampling or external artifact-store policy yet.
- **LSC.VER.SCEN-DQ3 Performance reuse realization.** Core
  LS.SYS.VER.SCEN-DQ3 remains open; no Scenario currently emits a portable
  performance verdict.
