# Discord Bot Runtime — Requirements

Role: own the long-lived Discord Gateway/REST process boundary on which the
LiveStore Discord bot's feature handlers run.

## Context

This is a runtime sub-node of the contrib-owned Discord bot application. It
does not realize a LiveStore core runtime adapter contract: "runtime" here
means the bot process and Discord protocol lifecycle, not a LiveStore store
runtime.

The private application implements this contract with canonical Cloudflare and
retained Node source realizations. Source and staging reachability are not a
production verdict; production admission remains owned by the
[Operations requirements](../04-operations/requirements.md).

## Requirements

- **LSC.APP.DISCORD.RT-R01 DFX protocol foundation:** The application uses DFX
  for Discord Gateway lifecycle, typed dispatch delivery, REST access, rate
  limiting, and interaction transport. Application code must not grow a second
  handwritten Discord Gateway or REST client. `refines: LSC.APP.DISCORD-R03`

- **LSC.APP.DISCORD.RT-R02 Gateway is required:** The production runtime holds a
  Discord Gateway connection and routes typed dispatches to feature handlers.
  An interaction-webhook-only deployment is insufficient because automatic
  threading depends on observing `MESSAGE_CREATE` events.

- **LSC.APP.DISCORD.RT-R03 Exact least-privilege intents:** The initial Gateway
  identify requests exactly `Guilds | GuildMessages | MessageContent`.
  `MessageContent` is privileged but required because threading policy and
  thread naming inspect message text. Adding any other intent requires an
  explicit requirement change and review of the corresponding data access.

- **LSC.APP.DISCORD.RT-R04 One active runtime initially:** The initial
  production topology has one active application runtime and one DFX Gateway
  session. The runtime does not require horizontal sharding or active/active
  coordination at initial scope. Feature handlers must nevertheless tolerate
  repeated dispatch observation around reconnects.

- **LSC.APP.DISCORD.RT-R05 Protocol-correct connection lifecycle:** The runtime
  heartbeats, resumes resumable sessions, backs off transient reconnects, and
  stops retrying terminal Discord close codes. At minimum `4004`, `4010`,
  `4011`, `4012`, `4013`, and `4014` are terminal. A terminal close must become
  a visible failed runtime rather than an infinite reconnect loop.

- **LSC.APP.DISCORD.RT-R06 Coherent Effect dependency graph:** The selected DFX,
  Effect, `@effect/platform-node`, and related prerelease versions form one
  reproducibly locked, peer-compatible dependency graph. Install and typecheck
  must not depend on an accidentally newer prerelease selected by a caret range.
  The admitted baseline is the exact tuple in decision 0003.

- **LSC.APP.DISCORD.RT-R07 Injectable side-effect boundary:** Feature handlers
  depend on narrow Discord action ports backed by DFX REST in production and by
  recording fakes in tests. Credential-free tests can feed typed Gateway
  dispatches through the same handler graph and prove both intended actions and
  non-actions.

- **LSC.APP.DISCORD.RT-R08 Honest readiness:** Process liveness alone must not
  report the bot ready. Readiness requires an established, identified Gateway
  session capable of receiving dispatches; a terminal Gateway failure removes
  readiness and is surfaced to the process supervisor.

- **LSC.APP.DISCORD.RT-R09 Cloudflare singleton runtime authority:** Each
  environment's canonical runtime is a Cloudflare Worker addressing one fixed,
  SQLite-backed singleton Durable Object. That object is the only Gateway
  mutation authority and durably owns the resumable session, action journal,
  and validated runtime configuration. Isolate or release restart must restore
  and validate that state, resume or establish the one session, and reconcile
  durable actions before admitting new mutation; an incomplete or invalid
  recovery fails closed. The Alchemy v2 host realization and independent
  production admission gate remain owned by
  [LSC.APP.DISCORD.OPS-R14 and OPS-R19](../04-operations/requirements.md#must-be-deployable-and-recoverable).
  The Node host is buildable source fallback, not a second live topology.

## Resolved technical decisions

- The bot uses an isolated private dependency graph rather than requiring a
  contrib-wide Effect upgrade ([decision 0001](./.decisions/0001-isolated-effect-graph.md)).
- Production admission requires an upstream DFX release or exact tested patch
  that classifies terminal close codes before retry
  ([decision 0002](./.decisions/0002-terminal-close-admission.md)).
- The private application pins the clean-install/typecheck/test baseline from
  [decision 0003](./.decisions/0003-pin-validated-dfx-graph.md).

## Open Design Questions
