# CLI — Requirements

Role: the `livestore` command-line tool — a standalone developer utility for
scaffolding example projects, moving a store's events in and out of a sync
backend, and exposing LiveStore to AI agents over MCP.

## Context

Unlike the adapter, sync, integration, and devtools contrib nodes, the `cli`
package **realizes no core `02-system/` dimension** — it is a top-level node, not
a dimension realization (contrib [spec.md](../spec.md)). It therefore refines no core
requirement; it is a *consumer* of core contracts, not a realization of one, so
these requirements carry no `refines:` markers. Where it touches core contracts
it does so as a client: it connects to sync backends through the core sync
provider contract
([`02-system/03-sync/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync),
`LS.SYS.SYNC-*`) and boots in-memory stores through the Node adapter
([`adapters/node/`](../adapters/node/requirements.md),
`LSC.ADAPT.NODE-*`, which realizes the runtime contract `LS.SYS.RT-*`). Package:
[`packages/@livestore/cli`](../../packages/@livestore/cli).

Its only structural tie to core is delivery membership: core's composition
requirement
[LS.DEL.COMP-R02](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/requirements.md)
classifies the CLI as a contrib-owned package — a packaging fact, not a contract
this node realizes. The contrib-hosted, `LSC.*`-namespaced, standalone-node model
is set by core decision
[0003](https://github.com/livestorejs/livestore/blob/main/context/.decisions/0003-contrib-referencing.md).

The tool is explicitly experimental and prints a warning on every invocation
(`src/bin.ts:14`).

## Requirements

- **LSC.CLI-R01 Single `livestore` binary, three subcommands:** The package
  ships one executable (`livestore`, `package.json` `bin`) whose root command
  fans out to exactly three subcommands — `create`, `sync`, and `mcp`
  (`src/cli.ts:7`) — built on `@effect/cli` and run on the Node platform runtime
  (`src/bin.ts:9`, `:17`).

- **LSC.CLI-R02 Example-project scaffolding (`create`):** `create` fetches the
  list of examples from the LiveStore monorepo's `examples/` directory at a
  chosen git ref (default `main`), lets the user pick one interactively or by
  `--example`, downloads and extracts that ref's tarball, copies the example into
  a destination directory, and prints package-manager-aware next steps. Examples
  are sourced from the public `livestorejs/livestore` repository, not vendored in
  the package.

- **LSC.CLI-R03 Sync-backend event import/export (`sync`):** `sync export` pulls
  every event from a user-configured sync backend into a versioned JSON file, and
  `sync import` pushes events from such a file back into an **empty** sync
  backend. Both operate directly on the sync backend via the core sync provider
  contract (`LS.SYS.SYNC-*`) without booting a full store, and both guard on a
  `storeId` match (overridable with `--force`).

- **LSC.CLI-R04 MCP server (`mcp server`):** `mcp server` runs a stdio
  Model-Context-Protocol server that exposes LiveStore to AI agents as static
  documentation resources plus a toolkit: schema generation and example schemas,
  an AI "coach", direct sync import/export, and a live single-instance surface
  (connect / query / commit-events / status / disconnect) backed by an in-memory
  Node adapter store.

- **LSC.CLI-R05 User config-module contract:** Commands and tools that talk to a
  store or sync backend load a user module (resolved relative to cwd) that must
  export a LiveStore `schema` and a `syncBackend` constructor, and may export
  `syncPayload` / `syncPayloadSchema`; the loader validates these before use.
  This is the single seam through which the CLI learns an app's schema and how to
  reach its backend.

- **LSC.CLI-R06 Ambient-credential configuration:** The CLI takes no secrets as
  flags. It reads `GITHUB_TOKEN`/`GH_TOKEN` for GitHub API access, `OPENAI_API_KEY`
  for the coach tool, and any backend auth via the config module's `syncPayload`
  (typically env-sourced by the user's module).

## Open Design Questions

- **LSC.CLI-DQ1 Coach provider is hardwired.** The `livestore_coach` tool is
  pinned to OpenAI `gpt-4o-mini` and hard-fails without `OPENAI_API_KEY`; whether
  the model/provider should be configurable (or the tool should ship at all in a
  local-first CLI) is unresolved.

- **LSC.CLI-DQ2 MCP server version is a separate constant.** The MCP server
  advertises a hardcoded `version: '0.1.0'` independent of the package version
  (`liveStoreVersion`); which version an agent should trust is unspecified.

- **LSC.CLI-DQ3 Import requires a fully empty backend.** `sync import` refuses
  any non-empty backend rather than merging or resuming; there is no partial or
  idempotent import path, which limits its use for incremental migration.
