# Scenario Verification Realization — Requirements

Role: the private contrib realization of LiveStore's mechanism-independent
composed-system verification requirement: Scenario model, runner, participant
hosts, backend profiles, corpus, evidence protocol, artifacts, and React viewer.

## Context

Refines core
[`LS.SYS.VER-R08`](https://github.com/livestorejs/livestore/blob/main/context/02-system/09-verification/requirements.md),
which defines the required composed-system evidence boundary without
prescribing or registering a Scenario mechanism. This node owns the concrete
model, protocol, terminology, realization choices, and gaps for the private
[`@local/tests-scenarios`](../../../tests/scenarios) workspace.
`refines: LS.SYS.VER-R08`

## Requirements

- **LSC.VER.SCEN-R01 One private verification workspace:** The runner, model,
  hosts, backend realizations, corpus, CLI, artifacts, React viewer, Storybook,
  and parity tests stay in one private `tests/scenarios/` workspace. It may
  depend on materialized core packages, but is never part of the product
  publish surface and no core package depends on it.
- **LSC.VER.SCEN-R02 Three participant profiles with explicit backend
  composition:** The realization provides in-process, isolated Node process,
  and persistent Chromium participant profiles. The in-process profile can use
  the controlled `makeMockSyncBackend`; process and browser evidence use a
  local real `sync-cf` Worker and Durable Object behind a Scenario-owned
  availability proxy. Each composition advertises only the controls and
  evidence it actually supplies.
- **LSC.VER.SCEN-R03 One portable model and corpus across profiles:** Typed
  Application definitions over real `LiveStoreSchema` values, declarative and
  versioned Scenario ASTs, named actions, seeded Workloads,
  topology/lifecycle/fault plans, and preflight capability derivation are
  shared without profile-specific Scenario rewrites. Generated actions retain
  stable operation identity and deterministic seed derivation; a seed
  reproduces generated inputs and requested choices, not internal delivery
  order.
- **LSC.VER.SCEN-R04 Shared host conformance and bounded settlement:** Every
  implemented profile runs the same capability-parameterized host suite.
  Control acknowledgements, failure category, outcome certainty, sampled
  observations, recovery evidence, and terminal Settlement remain distinct;
  snapshot oracles require a terminal Settlement covering their participants.
- **LSC.VER.SCEN-R05 Truth-bounded evidence and replayable artifacts:** Runs
  retain normalized input, source/execution identity, seed, a versioned
  receipt-ordered semantic trace, explicit causal edges, participant-local and
  calibrated timing, sampled system observations, operation outcomes,
  verdicts, and failure evidence. Correlation, timestamps, and observation
  capture membership do not establish causation or exact Event lineage.
  Current portable coverage includes Eventlog equality, sampled confirmed
  prefixes, pending resolution, State convergence, expected application
  effects, operation history, and bounded recovery/Settlement; unsupported
  evidence is rejected rather than inferred. Once execution starts, failure
  still produces an artifact over the complete available trace prefix;
  preflight rejection may produce none.
- **LSC.VER.SCEN-R06 React replay viewer with parity evidence:** The canonical
  viewer is a React application over immutable run artifacts, with causal-flow
  and elapsed-time projections, topology, playback, raw record inspection,
  Storybook state fixtures, and Playwright screenshot/interaction parity. Its
  default sync-evidence projection aggregates Workload child actions and spaces
  material captures plus Scenario boundaries as semantic flow steps; the raw
  trace remains available without determining that projection's geometry. It
  never inspects or mutates participants directly; headless execution remains
  authoritative.
- **LSC.VER.SCEN-R07 Explicit local and CI verification surface:** Generated
  workspace and TypeScript composition register `tests/scenarios`; devenv
  provides runner, viewer, Storybook, build, and parity tasks with pinned
  browser support; CI has a dedicated required Scenario job covering the
  runner suites and both viewer builds/parity.

## Open Design Questions

- **LSC.VER.SCEN-DQ1 Failure minimization realization.** The current CLI
  preserves failures but does not shrink a generated workload or fault
  schedule. The dependency-aware
  reduction approach and first campaign are specified in
  [`tests/scenarios/RED_TEAMING.md`](../../../tests/scenarios/RED_TEAMING.md).
- **LSC.VER.SCEN-DQ2 Trace retention realization.** Tracked references use
  compressed complete artifacts, with no sampling or external artifact-store
  policy yet.
- **LSC.VER.SCEN-DQ3 Performance reuse realization.** No Scenario currently
  emits a portable performance verdict.
