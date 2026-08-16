# Running and inspecting scenarios

This is the operational reference for the scenario runner. For the short setup,
architecture, and common commands, start with the [scenario runner README](./README.md).

Run commands from the repository root unless a section says otherwise.

## CLI

```sh
pnpm --dir tests/scenarios scenario:run --help
pnpm --dir tests/scenarios scenario:run
pnpm --dir tests/scenarios scenario:run --profile process
pnpm --dir tests/scenarios scenario:run --profile browser
pnpm --dir tests/scenarios scenario:run --scenario concurrent-hotel-booking
pnpm --dir tests/scenarios scenario:run --scenario many-writer-convergence --set event_count=100
```

`concurrent-hotel-booking` is an intentional failure reproducer. It exits
non-zero after writing an inspectable artifact.

The Scenario AST does not select execution placement. The runner derives
required capabilities from its topology, operations, observations, and oracles,
then rejects a profile that cannot provide them.

## Select the LiveStore source

By default, the runner uses the materialized core source at `repos/livestore`.
Implementation-only changes require neither a LiveStore build nor an npm
snapshot.

Run a dependency-compatible branch, tag, or commit:

```sh
pnpm --dir tests/scenarios scenario:run \
  --core-ref feature/rebase-solution \
  --profile browser
```

A Git ref reuses the current composed dependency installation. If that ref
changes runtime dependency declarations, install it as an ordinary LiveStore
worktree and select its path instead:

```sh
pnpm --dir tests/scenarios scenario:run \
  --core-path ../livestore \
  --profile browser
```

`--core-path` includes dirty and untracked source changes, but the selected
worktree must already have its pinned dependencies installed. Artifacts record
the selected commit and a content hash for a dirty tree; machine-local paths are
printed only to the terminal.

The launcher serializes temporary changes to the `repos/livestore` projection,
restores the original materialization after success, failure, or interruption,
and repairs an abandoned projection on the next run.

## Backends

`in-process` defaults to the controlled mock backend. The `process` and
`browser` profiles default to the real local `sync-cf` Worker and SQLite Durable
Object. You can also select a compatible backend explicitly:

```sh
pnpm --dir tests/scenarios scenario:run \
  --profile in-process \
  --backend local-sync-cf
```

### Cloudflare

Cloud execution is opt-in. Select `cloud-sync-cf` to deploy or reuse a dedicated
Worker backed by a real Cloudflare SQLite Durable Object:

```sh
pnpm --dir tests/scenarios scenario:run \
  --profile process \
  --backend cloud-sync-cf
```

Interactive use falls back to `wrangler login`. Automation supplies
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Provisioning caches its
scoped sync credential under the ignored `.wrangler/` directory and redeploys
when the selected LiveStore revision changes.

Attach to an already deployed compatible Worker by setting both:

```sh
export SCENARIO_CLOUD_SYNC_URL='https://...'
export SCENARIO_CLOUD_SYNC_TOKEN='...'
```

Additional controls:

- `SCENARIO_CLOUD_WORKER_NAME` overrides the managed Worker name.
- `SCENARIO_CLOUD_FORCE_DEPLOY=1` forces a managed redeployment.

Every run uses a unique physical Store ID and clears its Durable Object storage
during teardown. Ordinary local and CI runs never provision Cloudflare.

## Artifacts and diagnostics

Use `--output <path>` to choose the artifact path. The default is
`tests/scenarios/artifacts/<scenario-id>.json`.

Useful environment variables:

- `SCENARIO_PROGRESS=1` prints instruction and settlement progress.
- `SCENARIO_BROWSER_HEADLESS=0` shows the browser while a browser profile runs.
- `SCENARIO_BROWSER_DB_SNAPSHOT_DIR=<directory>` exports the first session,
  leader, and eventlog databases immediately before each browser Client
  reconnects.

The artifact retains the normalized Scenario, execution identity, trace,
observations, operation outcomes, snapshots, and verdicts. Failed runs preserve
the partial evidence collected before failure.

## Viewer and Storybook

Start the artifact viewer:

```sh
pnpm --dir tests/scenarios viewer
```

The viewer refreshes its **Saved runs** catalog from `tests/scenarios/artifacts`.
Its file picker can also open a `.json` or `.json.gz` artifact from elsewhere.
Tracked reference artifacts provide representative success, dense-action, and
failure states.

Start the component and state workbench:

```sh
pnpm --dir tests/scenarios storybook
pnpm --dir tests/scenarios storybook:build
```

Run the viewer interaction and screenshot gate:

```sh
pnpm --dir tests/scenarios viewer:parity
```

## Test the runner and profiles

```sh
pnpm --dir tests/scenarios test
pnpm --dir tests/scenarios exec vitest run src/profiles/conformance.test.ts
pnpm --dir tests/scenarios exec vitest run src/profiles/browser/profile.test.ts
pnpm --dir tests/scenarios exec tsc --noEmit -p tsconfig.json
```

Repository-level task equivalents install their prerequisites automatically:

```sh
devenv tasks run test:scenarios --mode before
devenv tasks run test:scenarios:viewer-build --mode before
devenv tasks run test:scenarios:viewer-parity --mode before
```
