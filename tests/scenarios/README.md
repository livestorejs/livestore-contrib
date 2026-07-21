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

## View the artifact

```sh
pnpm --dir tests/scenarios viewer
```

Open the printed URL and choose a generated artifact from **saved runs**. The
scenario CLI refreshes this local catalog whenever it writes into `artifacts/`;
the file picker can still open an artifact from elsewhere.

## Test the profiles

```sh
pnpm --dir tests/scenarios test
pnpm --dir tests/scenarios exec vitest run src/scenario-runner.test.ts --testNamePattern "browser profile"
pnpm --dir tests/scenarios exec tsc --noEmit -p tsconfig.json
```

The scenario AST does not select execution placement. The same portable
scenario can therefore run through the in-process, isolated Node process, or
browser host when its declared capabilities are available.
