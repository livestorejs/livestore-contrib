# Discord Bot Operations - Requirements

Role: the operational contract that turns the Discord bot application into an
owned, observable, safely deployable service. It specializes the parent
[Discord bot requirements](../requirements.md) and owns the selected runtime
host, deployment controller, environment isolation, and telemetry topology.

## Context

Automatic threading consumes ambient Discord Gateway events, so it cannot be
realized by a request-only interaction endpoint. The operation must own a
persistent session and the authority used by that session. Current-state and
prototype evidence is recorded in [`.reference/`](./.reference/); the absent
owned runtime is tracked in [`.delta/`](./.delta/).

## Assumptions

- **LSC.APP.DISCORD.OPS-A01 Provisionable environment identities:** LiveStore
  can provision and retain control of fresh Discord applications for production
  and staging, install the production application in the existing community
  guild, and declare their public IDs. Historical application
  `1310646763505582171` owns Molty/Clawdbot commands and is unavailable to this
  application.

- **LSC.APP.DISCORD.OPS-A02 Gateway-required feature set:** Automatic
  threading requires a persistent Gateway consumer with the Guilds,
  GuildMessages, and privileged MessageContent intents. Explicit interaction
  commands alone do not remove that runtime obligation.

- **LSC.APP.DISCORD.OPS-A03 DFX transport boundary:** The application uses DFX
  for Discord Gateway, REST, and interaction transport. Business policy remains
  testable without a live Discord connection.

## Acceptable Tradeoffs

- **LSC.APP.DISCORD.OPS-T01 Availability before overlap:** Deployment and
  rollback may briefly interrupt automatic actions in order to prevent two
  production consumers from acting on the same Gateway event.

- **LSC.APP.DISCORD.OPS-T02 Content-free diagnostics:** Troubleshooting may be
  less convenient because routine telemetry and receipts omit raw message,
  prompt, and generated-answer content.

- **LSC.APP.DISCORD.OPS-T03 Isolated test artifacts:** A live staging E2E may
  create and delete a marker message and thread in a purpose-declared target;
  it may not write into an ordinary community conversation.

## Requirements

### Must have declared authority and configuration

- **LSC.APP.DISCORD.OPS-R01 Declared deployment identity:** Every environment
  declares the Discord application ID, guild ID, release identity, operational
  owner, and environment name in reviewable configuration. Startup fails before
  connecting when the runtime identity returned by Discord disagrees with the
  declared application identity, when production and staging application IDs
  match, or when either resolves to reserved historical application
  `1310646763505582171`. Fresh application provisioning is an explicit
  control-plane operation, never an implicit side effect of deployment. `refines:
  LSC.APP.DISCORD-R01, LS.DEL.INFRA-R01, LS.DEL.INFRA-R04`

- **LSC.APP.DISCORD.OPS-R02 Validated configuration boundary:** All mutable
  deployment inputs are decoded as one versioned configuration before handlers
  start. Unknown environment names, malformed Discord snowflakes, an empty
  action-channel set, or production targets that overlap staging-only targets
  fail closed with no Discord mutation.

- **LSC.APP.DISCORD.OPS-R03 Secret-reference credentials:** Bot, E2E actor, and
  environment-specific OpenAI service-account tokens have one canonical value
  in 1Password and are supplied through named
  references into the deployment provider's secret facility with
  least-privilege access. They never appear as command arguments, committed
  values, generated manifests, ordinary provider configuration, logs,
  telemetry attributes, or test receipts. Rotation replaces a credential
  without changing the application identity or release artifact. `refines:
  LS.DEL.INFRA-R02, LS.DEL.INFRA-R03, LS.DEL.INFRA-R06`

- **LSC.APP.DISCORD.OPS-R04 Single active actor:** At most one runtime instance
  per environment may consume Gateway events with mutation authority. Startup,
  deployment, and rollback controls prevent overlap rather than relying on
  handler timing or Discord delivery behavior. On dev4, a host-local lock and
  stop-old, start-new systemd activation enforce this invariant.

### Must expose truthful service health

- **LSC.APP.DISCORD.OPS-R05 Readiness from dependencies:** Readiness is false
  until configuration and credentials are valid, Discord has authenticated the
  declared identity, a Gateway READY dispatch has established a session, the
  REST identity probe succeeds, and all required handlers are registered.
  Gateway loss immediately withdraws readiness; fatal authentication, shard,
  API-version, or intent close codes enter a terminal state instead of a
  reconnect loop.

- **LSC.APP.DISCORD.OPS-R06 Externally observable health:** The deployment
  platform observes liveness and readiness independently of process existence.
  An operator can determine environment, release, lifecycle state, last
  successful Gateway activity time, and last successful REST probe without
  reading a host-local console or message content. `refines:
  LSC.APP.DISCORD-R04`

### Must prove the real Discord boundary safely

- **LSC.APP.DISCORD.OPS-R07 Layered E2E gate:** The release gate runs
  credential-free policy tests and a live staging E2E through a separate actor
  identity. The live run proves Gateway receipt, one correlated thread mutation,
  and cleanup through Discord's real API before the release is production
  eligible. Staging uses a separate Discord application and dedicated guild;
  an absent staging credential or target yields UNRUN, never PASS.

- **LSC.APP.DISCORD.OPS-R08 Fail-closed live target:** Live E2E writes require
  an explicit write confirmation, exact guild and channel IDs, membership in an
  allowlist, and a purpose marker fetched from the target itself. Cleanup may
  delete only artifacts correlated to the current run; cleanup failure fails
  the run and leaves a sanitized recovery receipt.

- **LSC.APP.DISCORD.OPS-R09 Production verification:** After deployment,
  verification proves the exact release, declared Discord identity, readiness,
  and a currently healthy Gateway session. It does not
  post a marker into an ordinary production channel. If an isolated production
  canary target is later accepted, it must satisfy the same ownership and
  cleanup constraints as staging.

### Must minimize and retain operational data deliberately

- **LSC.APP.DISCORD.OPS-R10 Content-private telemetry:** Logs, spans, metrics,
  alerts, and receipts never contain tokens, raw Discord IDs, usernames, message
  content, prompt context, generated answers, or docs excerpts. They may contain
  event type, policy outcome, latency, error class, environment, release, and a
  run-scoped one-way correlation value.

- **LSC.APP.DISCORD.OPS-R11 Bounded best-effort traces:** Each environment
  exports content-free traces only through dev4's existing best-effort OTLP path
  to Tempo on dev3. Tempo retains traces for 30 days and operators use the
  fleet's existing tailnet-trusted Grafana boundary. Trace loss during a network
  or sink outage is acceptable; no durable delivery is claimed. Bot application
  logs and metrics are not exported to central Loki or Mimir in initial scope.
  Local systemd journal records follow current host retention and access policy
  without a bot-specific guarantee. A test injects secret and content sentinels
  through success and failure paths and proves that emitted spans, local log
  records, and durable receipts contain none of them.

### Must be deployable and recoverable

- **LSC.APP.DISCORD.OPS-R12 Immutable release and receipt:** A deployment runs
  an immutable artifact identified by source revision and dependency lock. Its
  receipt records environment, release, configuration digest, actor identity,
  readiness result, staged-E2E result, deploy time, and rollback target without
  recording secrets or raw Discord object IDs.

- **LSC.APP.DISCORD.OPS-R13 Bounded rollback:** An operator can restore the
  previous known-good release and configuration without rebuilding either.
  Rollback stops the candidate before starting its predecessor, rechecks
  readiness, and emits a new receipt; failure to restore readiness is surfaced
  as a failed rollback rather than success.

- **LSC.APP.DISCORD.OPS-R14 Declared NixOS realization:** The persistent
  Gateway runtime is a dedicated Nix-managed systemd service and service user
  on dev4, activated through the fleet's `deploy-rs` controller. Dotfiles owns
  host integration, secret projection, supervision, telemetry forwarding, and
  rollback; contrib owns the immutable artifact and decoded application
  configuration. Environment state is isolated under `/var/lib/discord-bot/`.
  `refines: LS.DEL.INFRA-R01, LS.DEL.INFRA-R04`

- **LSC.APP.DISCORD.OPS-R15 Isolated Discord environments:** Production and
  staging use fresh, distinct Discord applications and bot users. Production is
  installed in the existing community guild; staging uses a dedicated guild
  with no production membership and a distinct E2E Actor. Their application
  IDs, command sets, privileged-intent settings, tokens, guild membership, and
  runtime projections are disjoint. Historical application
  `1310646763505582171` remains untouched and excluded from deployment and
  command synchronization. Both environments request exactly the Gateway
  intents required by the runtime and receive only feature-required Discord
  permissions.

- **LSC.APP.DISCORD.OPS-R17 Bounded provider configuration:** Each environment
  declares the one dedicated OpenAI project identity, its own credential
  reference, standard-retention disclosure mode, and positive request/token/cost
  ceilings. Unknown projects, shared credentials, absent ceilings, alternate
  models, or claimed ZDR/residency without live verification fail startup or AI
  readiness without withdrawing basic threading readiness.

- **LSC.APP.DISCORD.OPS-R16 Authenticated administrative control:** Each
  environment exposes its typed Bot control RPC only through a protected Unix
  socket on dev4. Filesystem peer identity maps to the bot operator policy;
  remote access reuses authenticated SSH. There is no public admin listener,
  caller-supplied identity, direct-token CLI fallback, or second mutation
  authority. `refines: LSC.APP.DISCORD-R08`

## Resolved technical decisions

- Initial production verification is passive: identity, exact release/config
  digest, readiness, and current Gateway health; no ordinary production channel
  receives a mutation canary ([decision 0001](./.decisions/0001-passive-production-verification.md)).
- The singleton service runs on dev4 under NixOS systemd and `deploy-rs`
  ([decision 0002](./.decisions/0002-run-on-dev4.md)).
- Production and staging use fresh, disjoint Discord applications; staging also
  has a dedicated guild and E2E Actor, while the historical Molty identity stays
  untouched
  ([decision 0006](./.decisions/0006-use-fresh-discord-applications.md), which
  supersedes [decision 0003](./.decisions/0003-isolate-staging-discord-identity.md)).
- Content-free traces use the existing best-effort dev4-to-Tempo path with
  30-day retention and tailnet-trusted Grafana access; local journal records and
  durable application receipts remain separate
  ([decision 0005](./.decisions/0005-use-best-effort-central-traces.md), which
  supersedes [decision 0004](./.decisions/0004-use-central-content-free-telemetry.md)).
