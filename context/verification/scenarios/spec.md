# Scenario Verification Realization — Spec

Specifies the contrib-owned `tests/scenarios` realization. Builds on
[requirements.md](./requirements.md); portable Scenario semantics remain in the
[core contract](https://github.com/livestorejs/livestore/blob/main/context/02-system/09-verification/06-scenarios/spec.md).

## Status

Draft.

## Workspace Boundary

`@local/tests-scenarios` is private contributor tooling. Its generated manifest
depends on core packages through `repos/livestore/packages/@livestore/*`; the
root generator includes the resulting materialized closure. Release simulation
must continue to ignore this workspace. The runner/viewer and all associated
test-only browser dependencies therefore move together without creating a
published Scenario product package (LSC.VER.SCEN-R01).

## Execution Profiles

The same normalized Scenario and host contract are composed through:

| Profile      | Placement and state                                                                     | Backend baseline                   | Evidence boundary                                                       |
| ------------ | --------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `in-process` | Store and host in the runner process; SQLite                                            | controlled mock or local `sync-cf` | direct host boundary, sampled product state and Store shutdown failures |
| `process`    | isolated Node child process; SQLite                                                     | local `sync-cf`                    | serialized process protocol                                             |
| `browser`    | persistent Chromium context per Client, page per session; OPFS, SharedWorker, Web Locks | local `sync-cf`                    | serialized page protocol and browser observations                       |

The improved core `makeMockSyncBackend` gives each connection an independent
live Event broadcast, cursor-seeded/filtered pulls, a shared connection signal,
and an authoritative Event list. The Scenario realization consumes that seam;
it adds no database-diagnostics product API. The local `sync-cf` availability
fault affects only the participant route while the Worker and Durable Object
remain running (LSC.VER.SCEN-R02).

Every profile participates in `host-conformance.test.ts` for the capabilities
it advertises. Process IDs and browser profile directories are scoped resources
and must be absent after host teardown. Seeded reproduction covers inputs and
requested choices, not internal delivery order; exact Event lineage is not
advertised from sampled correlation (LSC.VER.SCEN-R03, R04).

## Corpus, Workloads, and Oracles

The baseline corpus covers offline-writer recovery, backend outage/recovery,
late catch-up, seeded mixed todo work, dynamic Client/session addition,
multi-session browser recovery and Leader turnover, and a shared workday
topology. It also includes the intentional `concurrent-decrement-rebase`
failure, which preserves a SQLite-enforced non-negative invariant violation
during pending-Event reconciliation. The associated
[red-team plan](../../../tests/scenarios/RED_TEAMING.md) defines the wider search,
promotion, failure-signature, and reduction campaign. Workload v1 expands application-owned named workloads sequentially
from a derived seed and retains the enclosing and child operation identities.

The oracle catalogue checks terminal Eventlog equality, sampled confirmed
Eventlog prefixes, pending resolution, State convergence, expected application
effects, operation histories, and bounded recovery/Settlement. It does not yet
claim rematerialization equivalence, resource bounds, or performance thresholds;
see [DELTA-001](./.delta/DELTA-001-surface-and-oracle-gaps.md).

Artifacts preserve failed as well as successful runs. Three compressed tracked
browser references back Storybook and parity coverage while ignored generated
`.json` runs remain local (LSC.VER.SCEN-R05).

## React Viewer

The React viewer is the canonical artifact consumer per
[decision 0002](./.decisions/0002-react-replay-viewer.md). Its controller owns
projection, playback, cursor, selection, viewport, and inspector state;
event-log scrolling and pointer bookkeeping stay component-local.
`deriveTimelineScene()` is DOM-free and feeds layered topology, causal-flow,
elapsed-time, range, and raw-record projections over the immutable trace.

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

## Core Integration Dependency

The realization must pin an upstream merged core commit containing
`livestorejs/livestore#1518`, the canonical `LS.SYS.VER.SCEN-R01`…`R21`
contract, core decision 0003, and the `makeMockSyncBackend` seam. The draft
fork head is coordination evidence only and is not a durable megarepo pin.
Effect prerelease overrides must be reconciled against that merged core before
full workspace and browser validation is claimed.
