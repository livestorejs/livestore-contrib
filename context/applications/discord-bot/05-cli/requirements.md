# Discord Bot CLI - Requirements

Role: expose scriptable, operator-safe access to the Discord bot's application
use cases without reimplementing feature policy or creating a second mutation
authority.

## Requirements

- **LSC.APP.DISCORD.CLI-R01 Thin typed surface:** The CLI is generated from or
  maps directly to the same rich schemas and typed use-case/RPC contract used
  by Discord handlers and operational tests. It contains parsing, transport,
  rendering, and confirmation behavior, but no eligibility, authorization,
  naming, reconciliation, retry, or provider policy. `refines:
  LSC.APP.DISCORD-R08`

- **LSC.APP.DISCORD.CLI-R02 Retroactive thread creation:** An authorized
  operator can inspect and request creation for an existing source message by
  canonical Discord message URL or exact channel/message identity. The explicit
  request bypasses automatic eligibility heuristics but still enforces target
  scope, operator authorization, source validation, existing-thread semantics,
  title policy, the durable action journal, and structured outcomes.

- **LSC.APP.DISCORD.CLI-R03 No direct production mutation:** Stateful commands
  call the active environment runtime through its authenticated administrative
  RPC boundary. The CLI never opens a second production Gateway session, writes
  SQLite directly, or calls Discord REST around the runtime. A stopped or
  unreachable runtime yields an explicit unavailable result.

- **LSC.APP.DISCORD.CLI-R04 Safe mutation contract:** Every write command names
  the target environment and requires `--apply` plus a non-empty operator
  reason. Plan commands perform decoding, reads, authorization, and pure policy
  evaluation without a Discord mutation, provider request, journal write, or
  misleading PASS. Mutations return a receipt/correlation identity. No
  `--force` bypass exists.

- **LSC.APP.DISCORD.CLI-R05 Common workflows:** Initial scope includes thread
  inspect/plan/create/status/reconcile, automatic-policy explanation, docs
  query/status, runtime health/status, redacted configuration validation/show,
  authentication status, application-command diff/sync, and the staging E2E
  gate. Every administrative RPC method is reachable from the CLI and every CLI
  command identifies its RPC/use-case mapping.

- **LSC.APP.DISCORD.CLI-R06 Composable output:** Every command supports stable
  `auto`, `log`, `json`, and, where results stream, `ndjson` output. Machine output uses
  the shared result/error schemas on stdout; diagnostics go to stderr. Text is
  problems-first, content-private, and includes an actionable next command for
  blocked or repairable outcomes.

- **LSC.APP.DISCORD.CLI-R07 Shared authorization and audit:** The runtime derives
  operator identity from the authenticated administrative transport, applies a
  configured operator policy, and records actor, reason, use case, target
  correlation, and outcome without raw message content. Flags cannot assert or
  override identity.

- **LSC.APP.DISCORD.CLI-R08 Deterministic automation:** Exit codes distinguish
  success/already-satisfied, invalid input, policy or authorization rejection,
  dependency unavailability, terminal failure, ambiguous/manual review, and
  UNRUN. `--help` documents mutation, external-provider, and production effects
  at every command that can cause them.

## Acceptable Tradeoffs

- **LSC.APP.DISCORD.CLI-T01 Remote writes require the runtime:** A production
  repair cannot fall back to direct credentials when the service is down. This
  preserves one authority and one journal at the cost of requiring service
  recovery before mutation.

- **LSC.APP.DISCORD.CLI-T02 Explicit target forms:** A bare message snowflake is
  insufficient unless it already exists in the journal. Requiring a message URL
  or channel/message pair avoids channel scanning and ambiguous operator intent.
