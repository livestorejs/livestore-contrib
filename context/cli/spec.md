# CLI — Spec

Specifies the `livestore` CLI (`packages/@livestore/cli`) at the tool-contract
level. Builds on [requirements.md](./requirements.md). The CLI realizes no core
dimension; where it consumes a core contract that contract's own spec governs.
Citations are `src/…:line` within the package.

## Status

Draft.

## Entry & Command Tree

The `livestore` binary (`package.json` `bin` → `src/bin.ts`) prints an
experimental-warning line (`src/bin.ts:14`, `:23`), then runs the root command
via `Cli.Command.run` with `version: liveStoreVersion` (`src/bin.ts:9`–`:12`)
under `PlatformNode.NodeContext.layer` + `FetchHttpClient.layer` + info-level
logging (`src/bin.ts:16`–`:25`). The root command carries a `--verbose` flag and
three subcommands (`src/cli.ts:7`–`:9`):

| Command | Subcommands | Source |
| --- | --- | --- |
| `create` | — | `src/commands/new-project.ts:221` |
| `sync` | `export`, `import` | `src/commands/import-export.ts:280`, `:171`, `:218` |
| `mcp` | `server` | `src/commands/mcp.ts:98`, `:77` |

## `create` — Project Scaffolding

Options: `--example` (optional; bypasses the prompt), `--ref` (aliases
`--commit`/`--branch`/`--tag`, default `main`), and a positional `path` arg
(`src/commands/new-project.ts:224`–`:240`). Flow:

1. **List examples** — GET `api.github.com/repos/livestorejs/livestore/contents/examples?ref={ref}`,
   keep `type === 'dir'` names, sorted (`src/commands/new-project.ts:69`–`:106`).
2. **Select** — use `--example` if given, else an interactive
   `Cli.Prompt.select` (`src/commands/new-project.ts:110`–`:126`, `:266`); the
   choice is validated against the fetched list (`:269`).
3. **Download & extract** — GET the ref tarball
   (`.../tarball/{ref}`), write to a tmp file, `tar -xzf` into a tmp dir, verify
   `examples/{name}` exists, then `cp -r` its contents into the resolved
   destination (default = the example name) and clean up
   (`src/commands/new-project.ts:129`–`:219`, `:280`–`:284`). `tar`/`cp` run as
   external `Command`s (`:165`, `:201`).
4. **Next steps** — read the new project's `package.json`, detect a `dev` vs
   `start` script (`:290`–`:295`), detect the invoking package manager, and print
   `cd` + install/run guidance (`:297`–`:323`).

Errors are tagged: `ExampleNotFoundError`, `NetworkError`, `DirectoryExistsError`,
`NoExamplesError` (`src/commands/new-project.ts:41`–`:66`).

**Package-manager detection** reads `npm_config_user_agent`
(`src/package-manager.ts:20`–`:30`): `bun`/`pnpm`/`npm` are supported, `yarn` is
reported `unsupported` and triggers a "use bun instead" warning
(`src/commands/new-project.ts:308`–`:315`); detection failure defaults to `bun`.

## `sync export` / `sync import`

Both take `--config` (`-c`, the config module), `--store-id` (`-i`), and
`--client-id` (defaults `cli-export` / `cli-import`); `export` takes an output
file arg, `import` takes an input file arg plus `--force` (`-f`) and `--dry-run`
(`src/commands/import-export.ts:171`–`:278`). The `sync` parent just groups them
(`:280`). Both operate directly on the sync backend — no store is booted.

- **export** (`src/commands/import-export.ts:17`–`:59`): `pullEventsFromSyncBackend`
  connects the backend, pulls all batches until `pageInfo._tag === 'NoMore'`,
  maps each to `eventEncoded`, and returns an `ExportFile`
  (`{ version: 1, storeId, exportedAt, eventCount, events }`,
  `src/sync-operations.ts:31`–`:42`, `:148`–`:201`); the command writes it as
  pretty JSON (`import-export.ts:48`, `:9`). A >100 000-event export warns about
  memory (`:12`, `:39`).
- **import** (`src/commands/import-export.ts:64`–`:169`): reads/parses the file,
  validates it against `ExportFileSchema`, and on a `storeId` mismatch fails
  unless `--force` (`:124`–`:137`; `sync-operations.ts:222`–`:246`). `--dry-run`
  stops after validation (`:146`–`:150`). Otherwise `pushEventsToSyncBackend`
  **refuses a non-empty backend** (it pulls one head batch first and errors if any
  events exist, `sync-operations.ts:305`–`:329`) and pushes in batches of 100 with
  a per-batch progress callback (`:331`–`:353`).

Backend lifecycle: `makeSyncBackend` loads the config module, constructs the
backend with `KeyValueStore.layerMemory`, `connect`s, and `ping`s with a 5 s
timeout, surfacing `ConnectionError` (`src/sync-operations.ts:68`–`:127`);
`acquireUseRelease` releases via the backend's `disconnect` or by clearing
`isConnected` (`:129`–`:133`, `:161`, `:274`).

## `mcp server`

Runs a stdio MCP server (`McpServer.layerStdio`, name `livestore-mcp`, version
`'0.1.0'`, stdin/stdout via `PlatformNode`; pretty logging to stderr)
(`src/commands/mcp.ts:80`–`:95`). It provides two layers:

**Resources** (`src/commands/mcp.ts:17`–`:73`): eight static `livestore://…`
documents — `overview`, `features`, `getting-started`, `architecture`, and four
example schemas (`schemas/todo|blog|social|ecommerce`).

**Toolkit** (`livestoreToolkit`, `src/commands/mcp-tools-defs.ts:5`, wired to
handlers at `mcp.ts:75`):

- `livestore_coach` — LLM review of pasted code; OpenAI `gpt-4o-mini` behind
  `HttpClient → OpenAiClient → LanguageModel`, `apiKey` from `OPENAI_API_KEY`
  (`src/commands/mcp-coach.ts:7`, `:41`–`:44`); a `ConfigError` (missing key) is
  turned into a defect (`:129`).
- `livestore_generate_schema`, `livestore_get_example_schema` — return schema
  code for `todo`/`blog`/`social`/`ecommerce` or a templated custom schema
  (`mcp-tools-defs.ts:8`–`:40`; `mcp-tool-handlers.ts:22`+).
- `livestore_instance_connect` / `_query` / `_commit_events` / `_status` /
  `_disconnect` — a **single** live instance per MCP session; connect imports the
  config module and boots an in-memory Node adapter store with blocking initial
  sync (`src/mcp-runtime/runtime.ts:1`–`:60`, esp. `makeNodeAdapter({ storage:
  { type: 'in-memory' } … })` `:39`–`:50`, `disableDevtools: true` `:57`), and
  reconnecting shuts down and replaces the previous instance
  (`src/mcp-runtime/runtime.ts:63`–`:72`).
  `_query` is read-only SQLite; `_commit_events` is annotated destructive
  (`mcp-tools-defs.ts:153`, `:190`).
- `livestore_sync_export` / `livestore_sync_import` — the same `SyncOps` used by
  the `sync` command, exposed as tools over a
  `NodeFileSystem` + `FetchHttpClient` layer
  (`mcp-tool-handlers.ts:8`, `:14`; `mcp-tools-defs.ts:231`–`:317`).

## Config Module Contract

`loadModuleConfig` resolves `configPath` against cwd, dynamically `import()`s it,
and validates exports (`src/module-loader.ts:29`–`:94`): `schema` must pass
`isLiveStoreSchema` (`:55`), `syncBackend` must be a function (`:63`), and
`syncPayload` — if present — is decoded against `syncPayloadSchema` (default
`Schema.JsonValue`) (`:71`–`:86`). This module is the sole input for `sync
export/import`, the MCP sync tools, and `livestore_instance_connect`.
