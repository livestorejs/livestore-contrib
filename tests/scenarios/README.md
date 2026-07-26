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
pnpm --dir tests/scenarios scenario:run --profile process --scenario backend-outage-recovery
pnpm --dir tests/scenarios scenario:run --profile process --scenario seeded-todo-workload
pnpm --dir tests/scenarios scenario:run --profile process --scenario late-client-catch-up
pnpm --dir tests/scenarios scenario:run --profile browser --scenario browser-multi-session-recovery
pnpm --dir tests/scenarios scenario:run --profile process --scenario shared-todo-workday --output artifacts/shared-todo-workday-process.json
pnpm --dir tests/scenarios scenario:run --profile browser --scenario shared-todo-workday --output artifacts/shared-todo-workday-browser.json
```

`in-process` defaults to the controlled mock backend. `process` and `browser`
use the local real `sync-cf` Worker and SQLite Durable Object. The browser
profile launches headless Chromium with one persistent browser context per
Client, one page per session, OPFS, a SharedWorker, and Web Locks. Set
`SCENARIO_BROWSER_HEADLESS=0` to watch it run.

Use `--output <path>` to choose the artifact path. By default it is written to
`tests/scenarios/artifacts/<scenario-id>.json`.
Set `SCENARIO_PROGRESS=1` to print step and settlement transitions for a long
run.
Set `SCENARIO_BROWSER_DB_SNAPSHOT_DIR=<directory>` to export the first session,
leader, and eventlog databases immediately before each browser Client
reconnects.

## View the artifact

```sh
pnpm --dir tests/scenarios viewer
```

Open the printed URL and choose a generated artifact from **saved runs**. The
scenario CLI refreshes this local catalog whenever it writes into `artifacts/`;
the file picker can still open an artifact from elsewhere.

Tracked `.json.gz` reference artifacts are also included in the saved-run
catalog. They preserve diagnostically useful failures without adding the full
uncompressed traces to the repository.

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

A `workload` step keeps a repeated application pattern compact by naming an
application-owned workload, its serializable input, allowed targets, and a
bounded action count. The runner resolves and expands the workload before it
creates any Client, using a workload-specific seed derived from the Scenario
seed and stable phase/step identity. The callback remains in the application
definition rather than the AST. Every generated action receives a stable child
operation ID and ordinary action instruction/acknowledgement records; the
workload retains its own enclosing instruction/outcome boundary. Workload v1
dispatches generated actions sequentially and allows between 1 and 10,000
actions.

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
pnpm --dir tests/scenarios exec vitest run src/scenario-runner.test.ts --testNamePattern "browser profile"
pnpm --dir tests/scenarios exec tsc --noEmit -p tsconfig.json
```

The scenario AST does not select execution placement. The same portable
scenario can therefore run through the in-process, isolated Node process, or
browser host when its required capabilities are available. The runner derives
requirements implied by topology, operations, observations, and oracles;
`requires` is only needed for additional platform-specific guarantees. Run the
shared profile contract directly with:

```sh
pnpm --dir tests/scenarios exec vitest run src/host-conformance.test.ts
```
