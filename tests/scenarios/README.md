# Sync scenarios

This private workspace runs declarative sync scenarios through real LiveStore
components and writes replayable JSON artifacts for the scenario viewer.

## Run a scenario

From the repository root:

```sh
pnpm --dir tests/scenarios scenario:run
pnpm --dir tests/scenarios scenario:run --profile in-process --backend local-sync-cf
pnpm --dir tests/scenarios scenario:run --profile process
pnpm --dir tests/scenarios scenario:run --profile browser
pnpm --dir tests/scenarios scenario:run --profile process --backend cloud-sync-cf
pnpm --dir tests/scenarios scenario:run --scenario concurrent-hotel-booking
pnpm --dir tests/scenarios scenario:run --profile browser --scenario browser-multi-session-recovery
pnpm --dir tests/scenarios scenario:run --scenario-file local/scenarios/my-investigation.ts
```

The default command runs directly against the materialized core source at
`repos/livestore`. Select another dependency-compatible Git branch, tag, or
commit without publishing a snapshot:

```sh
pnpm --dir tests/scenarios scenario:run --core-ref feature/rebase-solution --profile browser
```

Select an existing local LiveStore checkout or worktree, including its dirty
and untracked source changes, with a path resolved from the contrib root:

```sh
pnpm --dir tests/scenarios scenario:run --core-path ../livestore --profile browser
```

The local worktree must already have its pinned dependencies installed. A Git
ref reuses the current composed dependency installation and is therefore
accepted only while the Scenario-relevant core packages have the same runtime
dependency declarations; when a branch changes those declarations, install it
as an ordinary LiveStore worktree and use `--core-path` instead.

Core packages expose TypeScript source to the development workspace. The
launcher selects the source before loading the runner, so implementation-only
changes need neither a LiveStore build nor an npm snapshot. It serializes the
temporary `repos/livestore` projection, restores the original materialization
after success, failure, or an interrupt, and repairs an abandoned projection on
the next run. Artifacts record the selected core commit plus a content hash when
the selected working tree is dirty; machine-local paths are printed only to the
terminal.

`in-process` defaults to the controlled mock backend. `process` and `browser`
use the local real `sync-cf` Worker and SQLite Durable Object. The browser
profile launches headless Chromium with one persistent browser context per
Client, one page per session, OPFS, a SharedWorker, and Web Locks. Set
`SCENARIO_BROWSER_HEADLESS=0` to watch it run.

Select `--backend cloud-sync-cf` to deploy or reuse a dedicated Worker and run
against a real Cloudflare SQLite Durable Object. Local interactive use falls
back to `wrangler login`; automated use sets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. Provisioning happens only when this backend is
explicitly selected, caches its scoped sync credential under the ignored
`.wrangler/` directory, and redeploys when the selected LiveStore source
revision changes. Each run uses a unique physical Store ID and clears its DO
storage during scope teardown. Override the managed Worker name with
`SCENARIO_CLOUD_WORKER_NAME`.

To attach to an already deployed compatible Worker without provisioning it,
set both `SCENARIO_CLOUD_SYNC_URL` and `SCENARIO_CLOUD_SYNC_TOKEN`. Set
`SCENARIO_CLOUD_FORCE_DEPLOY=1` to force a managed redeployment.

Use `--output <path>` to choose the artifact path. By default it is written to
`tests/scenarios/artifacts/<scenario-id>.json`.
Set `SCENARIO_PROGRESS=1` to print step and settlement transitions for a long
run.
Set `SCENARIO_BROWSER_DB_SNAPSHOT_DIR=<directory>` to export the first session,
leader, and eventlog databases immediately before each browser Client
reconnects.

`concurrent-hotel-booking` is an intentional failure reproducer for the
command-replay RFC's invalid-rebase class. Its CLI process exits non-zero after
writing an inspectable artifact. See [RED_TEAMING.md](./RED_TEAMING.md) for the
broader campaign and failure-reduction plan.

## Author and promote a scenario

Concrete Application definitions live in [`src/corpus/applications`](./src/corpus/applications).
They contain only the real LiveStore schema, materializers, normal application
actions, and State inspectors. Scenario scheduling and generated activity never
enter an Application definition.

Start investigations in [`local/scenarios`](./local/scenarios), which is ignored
by Git. Copy `scenario.template.ts`, define the behavior next to its phases, and
run it with `--scenario-file`. This tier is for generated cases, parameter
sweeps, reductions, and hypotheses whose durable purpose is not established.

Promote only a reduced Scenario with a clear regression or representative
purpose. Move it to `src/corpus/scenarios/retained/findings/` or
`src/corpus/scenarios/retained/examples/`, add focused evidence, and register it
in `src/corpus/scenarios/registry.ts`. The retained CLI corpus intentionally has
six cases: SF-01 through SF-04 plus `offline-writer-recovery` and
`browser-multi-session-recovery`. Narrow host-contract fixtures live under
`src/test-support/scenarios` and are not presented as corpus cases.

Only register another Application when a Scenario genuinely needs a different
schema, action, materializer, or inspector surface. `src/corpus/registry.test.ts`
checks retained IDs and Application references.

## Inspect a scenario run

The scenario viewer is a React single-page application:

```sh
pnpm --dir tests/scenarios viewer
```

Open the printed URL (normally `http://localhost:5173`) and choose a generated
artifact from **saved runs**. The
viewer startup and scenario CLI refresh this local catalog from `artifacts/`;
the file picker can still open a `.json` or `.json.gz` artifact from elsewhere.
Saved-run options show the compact LiveStore revision used for each run. Once
opened, the header shows the full commit and dirty-content identity without
persisting the selected worktree's local path.

Only the four minimized sync failures carry identifiers: `SF-01` through
`SF-04`. The ID names the product-level finding and retained Scenario source;
an artifact is retained only when the current run still demonstrates that
finding. Ordinary and representative runs do not receive finding IDs. The
complete findings and reduction evidence are recorded in
[`SYNC_CORRECTNESS_FINDINGS.md`](./SYNC_CORRECTNESS_FINDINGS.md).

Storybook is the component and state workbench:

```sh
pnpm --dir tests/scenarios storybook
pnpm --dir tests/scenarios storybook:build
```

It opens at `http://localhost:6006` and includes primitive, topology,
inspector, sparse/dense timeline, lifecycle, failure, range, and complete-app
stories backed by the tracked reference artifacts.

The automated viewer gate validates interactions and compares the canonical
viewer with the approved migration baselines in desktop light, desktop dark,
and narrow light projects:

```sh
pnpm --dir tests/scenarios viewer:parity
```

The controller owns durable projection, playback, cursor, selection,
viewport, and inspector state. Event-log scroll and pointer-drag bookkeeping
remain local to the relevant components. `deriveTimelineScene()` is DOM-free;
the layered SVG renderer consumes its semantic layers and preserves the two-SVG
main-timeline/range-navigator organization.

The default timeline shows sync evidence: material observation captures and
Scenario boundaries receive semantic flow space, while generated child actions
are summarized by their enclosing action sequence. Switch to raw trace and record
playback when individual controller instructions and acknowledgements are
needed; those records remain intact but do not stretch the default flow axis.

Tracked current-format `.json.gz` artifacts are also included in the saved-run
catalog without adding the full uncompressed traces to the repository. The set
includes passed browser runs for `browser-multi-session-recovery` and
`offline-writer-recovery`, a dense seeded-action browser fixture, and current
SF-03 failure evidence.

Host acknowledgements mean only that the participant host completed handling
the controller request at its advertised boundary. They do not confirm backend
acceptance or propagation. The viewer keeps correlation (related evidence)
separate from explicit `causedBy` dependencies. The current operation-history
projection declares its application/control families and projects their
retained Control acknowledgements or failure outcomes across
instruction-to-outcome intervals. System/sync sampling and State inspection are
explicitly outside that coverage.

A `parallel` step schedules two or more ordinary non-settlement operations. It
records every child invocation before releasing the host requests, preserves
each child outcome, and joins the group before the next step. The
`operation-history` oracle can require named operations to have terminal,
non-indefinite outcomes and overlapping intervals.

`defineScenario(({ repeatActions }) => ...)` keeps repetition directly beside
the phase that owns it. The callback names ordinary application actions and
their inputs; keyed deterministic random choices derive from the Scenario seed,
phase ID, sequence ID, iteration, and choice key. Inserting an unrelated random
choice therefore does not shift later choices.

Authoring expands immediately into a serializable `action-sequence` containing
every concrete action and stable child operation ID. No callback or generator
crosses into the runner, participant hosts, or artifact. The runner dispatches
the embedded actions sequentially under one enclosing instruction/outcome
boundary, and raw trace retains every child action. An action sequence contains
between 1 and 10,000 actions.

The initial topology contains only participants that exist before the first
phase. A sequential `create-client` step can create a new Client with its first
sessions after history already exists; all profiles support that operation. A
sequential `add-session` step attaches a new session to an existing Client;
the browser profile realizes it by opening another page in the Client's
persistent context. Creation acknowledgements prove only that the Store or
page started. Settlement and oracles separately prove catch-up and convergence.
Participant additions are rejected in `parallel` groups, and removal is not
part of the current surface.

`browser-multi-session-recovery` also covers behavioral Leader turnover using
ordinary session lifecycle: the fixture starts the first page through blocking
Web Lock election, adds a sibling, closes the initial lock holder, writes
through the sibling, and then converges after restart. The artifact proves that
recovery path, but does not claim portable trace evidence naming the old and new
Leader sessions.

Participant-host failures carry a portable category for host infrastructure,
request rejection, invalid response, response timeout, or transport failure.
That category is independent from outcome certainty: a timeout or transport
loss after dispatch remains indefinite, while a known rejection or transport
failure before send is definite. Adapter-native details remain in the message.

Disconnect and backend-availability faults are injected or removed only when a
system observation confirms the state requested through the host. For local
`sync-cf`, a Scenario-owned TCP proxy temporarily withholds traffic on existing
participant sockets and rejects new connections; Wrangler, the Worker, and its
Durable Object state remain running. The authoritative backend observer uses a
direct route, so evidence remains readable during the participant-route outage.
This models a transient network blackhole, not a Wrangler/DO restart or recovery
after an established WebSocket is destroyed.

Settlement records quiescence from the runner's in-flight operation projection,
then retains recovery samples separately from the stable convergence barrier. A
reconnect or backend-availability acknowledgement is therefore not presented as
proof of recovery.

## Test the profiles

```sh
pnpm --dir tests/scenarios test
pnpm --dir tests/scenarios exec vitest run src/profiles/browser/profile.test.ts
pnpm --dir tests/scenarios exec tsc --noEmit -p tsconfig.json
```

The scenario AST does not select execution placement. The same portable
scenario can therefore run through the in-process, isolated Node process, or
browser host when its required capabilities are available. The runner derives
requirements implied by topology, operations, observations, and oracles;
`requires` is only needed for additional platform-specific guarantees. Run the
shared profile contract directly with:

```sh
pnpm --dir tests/scenarios exec vitest run src/profiles/conformance.test.ts
```
