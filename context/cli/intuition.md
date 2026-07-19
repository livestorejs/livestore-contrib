# CLI — Intuition

*For: contributors to `@livestore/cli` · Assumes: the core store/sync/adapter
mental model · Covers: why the CLI is a standalone tool, not a dimension
realization, and how its three commands relate*

Every other contrib package plugs into a hole the core left open — an adapter, a
sync provider, a devtools surface. The CLI plugs into none of them. It is a
*consumer* that stands beside the library and reaches into it from the outside:
it scaffolds projects that use LiveStore, moves a store's events across a sync
backend, and hands LiveStore to an AI agent. That is why it lives at the top
level of the contrib tree and refines no core requirement — reading it as "the
CLI dimension" is the first mental trap to avoid.

The three commands answer three different developer moments. **`create`** is the
"day zero" tool: it has nothing to do with the runtime — it just pulls an example
straight out of the public monorepo at a git ref and drops it on disk, so it is
really a thin, package-manager-aware GitHub fetcher. **`sync`** is the operational
tool: export/import talk to a sync backend *directly*, without ever booting a
store, which is why they need only the backend half of your config module and why
import insists the backend be empty — they move an eventlog wholesale, they do
not reconcile one. **`mcp`** is the agent tool: a stdio MCP server that is partly
static docs and partly a live, single-instance store (an in-memory Node adapter)
an agent can connect to, query, and commit into.

The load-bearing seam under `sync` and `mcp` is the **config module**: a user
file exporting `schema` + `syncBackend` (+ optional `syncPayload`). It is the one
place the CLI learns an app's shape and how to reach its backend; everything
store- or backend-touching flows through `loadModuleConfig`. Secrets never appear
as flags — GitHub, OpenAI, and backend auth are all ambient environment. Finally,
treat the whole tool as experimental (it says so on every run); the coach tool's
hardwired OpenAI dependency and the split MCP/package versions are unsettled edges
([requirements.md](./requirements.md) DQ1–DQ2), not commitments.
