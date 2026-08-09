# Scenario Verification Realization — Requirements

Role: the private contrib realization of LiveStore's mechanism-independent
composed-system verification requirement: Scenario model, runner, participant
hosts, backend profiles, corpus, evidence protocol, artifacts, and React viewer.

## Context

Refines core
[`LS.SYS.VER.LANE-R01`](https://github.com/livestorejs/livestore/blob/main/context/02-system/09-verification/01-lanes/requirements.md),
which defines the layered runnable verification surface. This node owns the
additional contrib Scenario lane's concrete model, protocol, terminology,
realization choices, and gaps for the private
[`@local/tests-scenarios`](../../../tests/scenarios) workspace.
`refines: LS.SYS.VER.LANE-R01`

## Requirements

- **LSC.VER.SCEN-R01 One private verification workspace:** The runner, model,
  hosts, backend realizations, corpus, CLI, artifacts, React viewer, Storybook,
  and parity tests stay in one private `tests/scenarios/` workspace. It may
  depend on materialized core packages, but is never part of the product
  publish surface and no core package depends on it.
- **LSC.VER.SCEN-R02 Three participant profiles with explicit backend
  composition:** The realization provides in-process, isolated Node process,
  and persistent Chromium participant profiles. The in-process profile can use
  the controlled `makeMockSyncBackend`; every compatible profile can use a real
  `sync-cf` Worker and Durable Object behind a Scenario-owned availability
  proxy. The baseline runs that provider under local workerd. An explicitly
  selected opt-in realization may instead deploy or attach to the provider on
  Cloudflare with a real SQLite Durable Object while preserving that
  participant/observer route separation. Ordinary local and CI checks never
  provision cloud resources. Each composition advertises only the controls and
  evidence it actually supplies.
- **LSC.VER.SCEN-R03 One portable model and corpus across profiles:** Typed
  Application definitions over real `LiveStoreSchema` values, declarative and
  versioned Scenario plans, named actions, one deterministic `.scenario.yaml`
  language, Scenario-owned seeded authoring, one ordered instruction stream,
  optional zero-effect annotations, topology/lifecycle/fault plans, top-level
  participant aliases with no runtime instruction, default or explicitly
  scoped oracle contracts, and preflight capability derivation are shared
  without profile-specific Scenario rewrites. The compiler derives normalized
  identity and capability bookkeeping, expands repetition into self-contained
  ordered action sequences, and rejects invalid source before execution;
  Application definitions contain no Scenario generation policy. Reusable,
  Application-neutral shared TypeScript helpers and optional same-name
  `.helpers.ts` companions containing actual one-off implementations expand
  finite declarative instruction fragments at the source-loading seam; no
  registration-only companion and no helper crosses into execution. Generated actions retain stable operation
  identity and deterministic keyed seed derivation; a seed reproduces generated
  inputs and requested choices, not internal delivery order.
- **LSC.VER.SCEN-R04 Shared host conformance and policy-bounded
  stabilization:** Every implemented profile runs the same
  capability-parameterized host suite. Control acknowledgements, failure
  category, outcome certainty, sampled observations, recovery evidence,
  intermediate Settlement, terminal stabilization, and oracle verdicts remain
  distinct. Snapshot oracles establish terminal stabilization for their
  participants; explicit Settlement is only an intermediate barrier. Run
  configuration, not Scenario source, bounds both waits.
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
  reconstructed Client Leader State inspection, Storybook state fixtures, and
  Playwright screenshot/interaction parity. At a timeline cursor, the viewer
  may lazily replay the latest recorded Leader Event facts at or before that
  cursor through the registered Scenario Application schema and its real
  materializers in an isolated in-memory Store. It labels the result with the
  source capture and record, exposes generic user-table contents plus sync
  heads, pending count, and Event count, and represents loading and replay
  failure explicitly. This is derived reconstruction from one sampled Leader
  observation, never the Client's actual historical database, a session State,
  or an atomic distributed snapshot. Its
  default sync-evidence projection aggregates action-sequence child actions and spaces
  material captures plus reached annotations as semantic flow steps; the raw
  trace remains available without determining that projection's geometry.
  Individual Event presentations use the recorded producer Client's timeline
  track color across observing components and Event position changes, while
  aggregated Event markers remain neutral. This encoding does not strengthen
  sampled correlation into exact Event lineage. The viewer never inspects or
  mutates participants directly; headless execution remains authoritative.
- **LSC.VER.SCEN-R07 Explicit local and CI verification surface:** Generated
  workspace and TypeScript composition register `tests/scenarios`; devenv
  provides runner, viewer, Storybook, build, and parity tasks with pinned
  browser support; CI has a dedicated required Scenario job covering the
  runner suites and both viewer builds/parity.
- **LSC.VER.SCEN-R08 Explicit Scenario promotion lifecycle:** Generated cases,
  investigation controls, and reductions begin in a Git-ignored local source
  tier and run explicitly by file. The registered retained corpus contains only
  minimized findings and representative examples with a stated durable purpose
  and focused evidence. Narrow host-contract fixtures may remain committed
  beside their tests without becoming CLI corpus entries. Promoting Scenario
  source never implicitly promotes a run artifact.
- **LSC.VER.SCEN-R09 Explicit elapsed-time instructions:** Scenario source can
  request a positive minimum controller delay with `wait`, and can apply the
  same fixed delay between completed actions in one repeated sequence. The
  first repeated action has no initial delay and the last has no trailing
  delay. Requested and observed controller-monotonic elapsed time are retained
  as trace evidence. Delay does not imply an exact schedule, Quiescence,
  Settlement, synchronization, or a performance verdict.

## Open Design Questions

- **LSC.VER.SCEN-DQ1 Failure minimization realization.** The current CLI
  preserves failures but does not shrink a generated action sequence or fault
  schedule. The dependency-aware
  reduction approach and first campaign are specified in
  [`tests/scenarios/RED_TEAMING.md`](../../../tests/scenarios/RED_TEAMING.md).
- **LSC.VER.SCEN-DQ2 Trace retention realization.** Tracked references use
  compressed complete artifacts, with no sampling or external artifact-store
  policy yet.
- **LSC.VER.SCEN-DQ3 Performance reuse realization.** No Scenario currently
  emits a portable performance verdict.
