# Scenario Verification Realization — Spec

Specifies the contrib-owned `tests/scenarios` realization. Builds on
[requirements.md](./requirements.md) and realizes core
[`LS.SYS.VER-R08`](https://github.com/livestorejs/livestore/blob/main/context/02-system/09-verification/requirements.md).
The Scenario mechanism and terminology specified here are contrib-owned; core
intentionally prescribes neither. A core discovery pointer may name this
realization and link here without taking ownership of its detailed intent.

## Status

Draft.

## Workspace Boundary

`@local/tests-scenarios` is private contributor tooling. Its generated manifest
depends on core packages through `repos/livestore/packages/@livestore/*`; the
root generator includes the resulting materialized closure. Release simulation
must continue to ignore this workspace. The runner/viewer and all associated
test-only browser dependencies therefore move together without creating a
published Scenario product package (LSC.VER.SCEN-R01).

## Scenario and Application Model

Committed and local cases are deterministic `.scenario` instruction files. A
compiler validates complete source and produces the current serializable
Scenario plan before execution. The filename stem supplies Scenario identity;
source selects one registered Application, declares explicit Client/session
topology, and contains one ordered body of operations, faults, annotations,
action sequences, intermediate Settlement instructions, and optional final
expectations. Profile/backend selection, Store identity, capabilities, tags,
format versions, and runner-owned instruction/oracle IDs are not authored.

Concrete Application definitions wrap the actual `LiveStoreSchema`; named
actions expose strict input validation before dispatch, State inspectors encode
their output as JSON, and they contain no Scenario generation policy. The
Scenario never redeclares Events or materializers. The normalized plan remains
the runner and artifact boundary; the runner does not interpret source text.

The topology separates the backend from stable Client identities and their
explicitly named sessions. Initial topology plus ordered Client/session
additions defines the complete participant set. Participant references are
fully qualified; Clients start connected unless declared disconnected; and
compile-time aliases resolve only participants that exist at their source
position. Lifecycle, connectivity, and backend-availability operations receive
stable compiler-owned IDs. An annotation is a zero-effect instruction that
emits a reached marker without creating an operation or execution boundary.
Scenario-owned repetition derives keyed choices from the Scenario seed plus
stable sequence, iteration, and choice identity, then expands immediately into
a serializable `action-sequence` containing every concrete action. No authoring
callback crosses into execution. Capability derivation sees the normalized plan
before the first Client is created. A recorded seed reproduces generated inputs
and requested choices from the same source revision; it does not claim to
reproduce internal host or Sync delivery order (LSC.VER.SCEN-R03).

## Execution Profiles

The same normalized Scenario and host contract are composed through:

| Profile      | Placement and state                                                                     | Backend baseline                          | Evidence boundary                                                       |
| ------------ | --------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `in-process` | Store and host in the runner process; SQLite                                            | controlled mock, local or cloud `sync-cf` | direct host boundary, sampled product state and Store shutdown failures |
| `process`    | isolated Node child process; SQLite                                                     | local or cloud `sync-cf`                  | serialized process protocol                                             |
| `browser`    | persistent Chromium context per Client, page per session; OPFS, SharedWorker, Web Locks | local or cloud `sync-cf`                  | serialized page protocol and browser observations                       |

The improved core `makeMockSyncBackend` broadcasts pushed and advanced Events
to every ordinary backend connection and seeds/filters each connection's pulls
from its requested cursor. The Scenario creates one additional normal
`SyncBackend` connection for observation, reads its standard `isConnected`, and
performs a non-live pull; it consumes no special shared-connection-signal or
authoritative-Event-list API. The local `sync-cf` availability fault affects
only the participant route while the Worker and Durable Object remain running
(LSC.VER.SCEN-R02).

The opt-in `cloud-sync-cf` realization either attaches to an explicitly
configured compatible endpoint or idempotently provisions a dedicated Worker
when Wrangler credentials are present. A TLS-aware Scenario-owned WebSocket
proxy retains the same availability-fault boundary while the authoritative
observer connects directly. Managed runs record the deployed backend revision,
isolate physical Store IDs, authenticate sync connections with a generated
Worker-level token cached in the ignored local Wrangler directory, and clear
per-run Durable Object storage on teardown. Cloudflare account credentials
remain environment- or Wrangler-owned and are never persisted by the Scenario
workspace. Cloud selection is explicit and therefore never makes the ordinary
verification surface mutate an external account.

Every profile participates in `src/profiles/conformance.test.ts` for the capabilities
it advertises. Process IDs and browser profile directories are scoped resources
and must be absent after host teardown. Seeded reproduction covers inputs and
requested choices, not internal delivery order; exact Event lineage is not
advertised from sampled correlation (LSC.VER.SCEN-R03, R04).

## Evidence Semantics

Trace protocol v5 is the authoritative evidence envelope. Each record has a
monotonic runner receipt index plus run, participant, instruction, operation,
emitter, and payload identity where applicable. The record's origin and
evidence semantics distinguish an instruction, host acknowledgement, sampled
observation, controller event, and oracle verdict. Acknowledgement means that
the host handled the request at its advertised boundary; it never proves
backend acceptance, propagation, or the requested product state.

Receipt index, participant-local sequence, logical time, wall time, local
monotonic time, calibrated elapsed-time interval, correlation, explicit
`causedBy` edges, and observation-capture membership remain distinct facts.
Logical time orders runner-owned instructions; wall time is retained for
externally comparable elapsed evidence. Same-process calibrated intervals
collapse to one controller-clock point, while process/browser readings retain
the full controller round trip as uncertainty. Timestamp order, correlation,
and capture membership never create a causal edge or affect LiveStore Sync
semantics. See [decision 0005](./.decisions/0005-causal-and-calibrated-time.md).

The viewer's cursor reduces the complete receipt-ordered trace prefix, not an
atomic distributed snapshot. System captures group component-scoped samples
from one collection pass. Participant hosts and backend observers collect
actual LiveStore Eventlogs, State, connectivity, and runtime failures rather
than deriving product state from requested controls. Current `eventRef` values
are run-local fingerprint/occurrence correlations for navigation; every host
explicitly withholds the `event-lineage` capability, so positions, equal
fields, timing, and these correlations cannot prove lineage. See
[decision 0004](./.decisions/0004-sampled-state-and-event-correlation.md).

Runner-invoked operations keep one stable ID across instruction,
acknowledgement, related observations, and outcome. Host failure category is
independent from whether the controller knows a failure is definite or lost a
response boundary and therefore marks the outcome indefinite. Fault requests,
acknowledgements, observed injection/removal, Recovery, Quiescence, Settlement,
and oracle verdicts are separate records. In particular, `fault.removed` is
emitted only after a later system sample observes restored connectivity or
availability; removal does not establish Recovery.

An explicit Settlement names its participants and any disconnected Clients to
heal. It rejects other in-flight Scenario operations, records Quiescence, and
requires two consecutive identical observations in which every selected
participant is synced, has no pending Events, has reached the backend global
position, and agrees on that position. It is an intermediate convergence
barrier used only when later instructions depend on a stable point, not proof
of Eventlog contents or State equality.

Final snapshot oracles establish the same terminal stable observation boundary
for their participants without an authored terminal Settlement. Run
configuration bounds intermediate and terminal stabilization; that safety
policy is not a Scenario performance assertion. Oracles evaluate separate
properties from retained evidence. Once execution begins, an operation or
stabilization failure produces a failed artifact containing the available trace
prefix. Scenario/Application/source/capability preflight can fail before a run
begins and therefore without an artifact. See
[decision 0006](./.decisions/0006-operation-settlement-and-property-evidence.md)
and
[decision 0012](./.decisions/0012-deterministic-scenario-language.md)
(LSC.VER.SCEN-R04, R05).

## Corpus, Authoring, and Oracles

The retained corpus contains four promoted `SF-*` failure reproducers and two
representative examples: offline writer recovery and browser multi-session
recovery. Focused host-contract Scenarios remain committed test fixtures
without becoming CLI corpus entries. Generated investigations, controls, and
reductions begin under the Git-ignored `local/scenarios/` tier and run by file;
promotion is the deliberate move of a reduced, focused `.scenario` source into
`retained/findings/` or `retained/examples/` plus registry and regression
evidence. Each Scenario selects one registered Application. The associated
[red-team plan](../../../tests/scenarios/RED_TEAMING.md) defines the wider search,
promotion, failure-signature, and reduction campaign. Scenario-owned repetition
retains both the enclosing action-sequence identity and every concrete child
operation in the normalized artifact.

Source without final expectations defaults to pending resolution and exact
ordered Eventlog convergence for every session still running at the end. One or
more explicit final participant-scoped expectation blocks replace both defaults
for the entire Scenario. The oracle catalogue also supports explicit State
convergence, expected application effects, and local operation histories;
specialized internal evidence may continue to check sampled confirmed-history
immutability without exposing it as DSL syntax. It does not yet claim
rematerialization equivalence, resource bounds, or performance thresholds; see
[DELTA-001](./.delta/DELTA-001-surface-and-oracle-gaps.md).

Artifacts preserve failed as well as successful runs. Three compressed tracked
browser references back Storybook and parity coverage while ignored generated
`.json` runs remain local (LSC.VER.SCEN-R05).

## Core Source Selection

The interactive entrypoint is an outer source launcher: it resolves the
megarepo materialization, a dependency-compatible Git ref, or an installed
local LiveStore worktree before spawning the product-importing Scenario CLI.
Core development exports address TypeScript source, so selection does not imply
an npm snapshot or `dist` build. Git-ref worktrees reuse the composed install
only when the Scenario closure's runtime dependency declarations match; a
dependency-changing or dirty local realization supplies its own installed
worktree through `--core-path`.

The fixed `repos/livestore` package-link seam is projected under an exclusive,
recoverable lock and restored on every ordinary exit path. A subsequent run
repairs a projection abandoned by a dead launcher. Artifact `sourceRevision`
records the selected core commit and, for a dirty worktree, a hash of tracked
diffs plus untracked contents; it never records the machine-local source path
(decision 0003).

## React Viewer

The React viewer is the canonical artifact consumer per
[decision 0002](./.decisions/0002-react-replay-viewer.md). Its controller owns
projection, playback, cursor, selection, viewport, and inspector state;
event-log scrolling and pointer bookkeeping stay component-local.
Saved-run choices include a compact LiveStore source revision, while an open
run shows its full commit and dirty-content identity in one provenance line.
`deriveTimelineScene()` is DOM-free and feeds layered topology, causal-flow,
elapsed-time, range, and raw-record projections over the immutable trace.
The default sync-evidence flow spaces material captures and reached Scenario
annotations as semantic steps. An action sequence is one summarized narrative boundary;
its generated child action instructions and acknowledgements remain available
in raw-trace navigation without consuming the default flow axis.

An individually rendered Event takes its color from the Client named by the
Event's recorded `origin.clientId`, using the same palette as that Client's
timeline tracks. The color therefore follows the recorded producer when the
Event appears in backend, Leader, or session observations and when its pending,
confirmed, position, or parent-position facts change. It does not use the
observing component's color and does not claim that the run-local `eventRef`
proves identity across samples. Timeline bins containing multiple Events keep
their existing neutral aggregate styling rather than implying one producer.
See [decision 0007](./.decisions/0007-color-individual-events-by-recorded-client.md).

Each observed Client Leader role can open a reconstructed State inspector. For
the selected Client and cursor, the viewer chooses the latest
`leader.sync.observed` record at or before the cursor, reports that record and
its capture as provenance, and lazily replays the observation's retained Event
facts into an isolated in-memory LiveStore using the artifact's registered
Scenario Application schema and real materializers. The generic result lists
user tables and rows and retains the source local/upstream heads, pending
count, and Event count. Loading and replay/materialization failures remain
visible instead of falling back to a requested operation or sampled inspector.

This derived result is always described as reconstructed or replayed State. It
is neither actual captured historical SQLite State nor session State, and it
does not strengthen a component sample into an atomic distributed snapshot.
Event order comes from the selected recorded Leader Event list; `eventRef` is
not used as exact lineage. Work is demand-driven and cached by artifact,
Client, and source record so timeline playback only changes the eligible source
and does not boot and materialize a Store every frame. The completed artifact
and trace remain authoritative. Session reconstruction, provenance across
historical Application/materializer revisions, and opt-in captured SQLite
snapshots remain follow-ups. See
[decision 0009](./.decisions/0009-reconstruct-leader-state-from-recorded-events.md).

Storybook exercises primitives and complete viewer states from the tracked
references. Playwright verifies interaction semantics and approved desktop
light, desktop dark, and narrow light screenshots with reduced motion. The
viewer is replay-only today; live streaming/control is tracked in
[DELTA-002](./.delta/DELTA-002-replay-only-viewer.md) (LSC.VER.SCEN-R06).

## Task and CI Surface

Devenv supplies `scenario:run`, `scenario:viewer`, and `scenario:storybook` for
interactive use plus `test:scenarios`, viewer/Storybook build tasks, and the
Playwright parity task. The dedicated required `pr/scenarios` job runs the full
aggregate with browsers supplied by the pinned Playwright devenv input.
`tests/scenarios` is included in lint, root workspace, TypeScript references,
workspace-shape enforcement, and lockfile generation (LSC.VER.SCEN-R07).
The required aggregate uses only local backend realizations; real Cloudflare
execution remains an explicit maintainer integration run.

## Core Integration Dependencies

The intent relationship depends on
[`livestorejs/livestore#1534`](https://github.com/livestorejs/livestore/pull/1534)
and its eventual merged core commit containing `LS.SYS.VER-R08`. Separately,
the executable mock profile depends on
[`livestorejs/livestore#1535`](https://github.com/livestorejs/livestore/pull/1535)
and its eventual merged `makeMockSyncBackend` broadcast/cursor fix. Neither PR
defines the contrib Scenario mechanism. Consistent with core decision 0003,
#1534 may include a minimal discovery pointer naming the contrib Scenario
runner/viewer and this intent home; #1535 adds no Scenario-specific observation
API.

Draft fork heads are coordination evidence only, not durable megarepo pins.
Contrib must repin to the upstream merge of both dependencies, and Effect
prerelease overrides must be reconciled against that composed core before full
workspace and browser validation is claimed.
