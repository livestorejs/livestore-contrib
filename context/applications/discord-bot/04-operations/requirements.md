# Discord Bot Operations - Requirements

Role: the operational contract that turns the Discord bot application into an
owned, observable, safely deployable service. It specializes the parent
[Discord bot requirements](../requirements.md) and owns deployment
realization, environment isolation, production admission, and telemetry
topology.

## Context

Automatic threading consumes ambient Discord Gateway events, so it cannot be
realized by a request-only interaction endpoint. The operation must own a
persistent session and the authority used by that session. Cloudflare staging
is the canonical live realization; current admission gaps remain tracked in
[`.delta/`](./.delta/) rather than being conflated with feature proof.

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

- **LSC.APP.DISCORD.OPS-R04 Runtime authority preservation:** Deployment
  preserves the singleton runtime authority required by
  `LSC.APP.DISCORD.RT-R09` across every Worker route, schedule, release version,
  rollout, and rollback. No transition may expose another Gateway actor with
  mutation authority or depend on Discord delivery behavior to suppress
  duplicate mutation. `refines: LSC.APP.DISCORD.RT-R09`

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

- **LSC.APP.DISCORD.OPS-R07 Layered functional E2E gate:** The functional gate
  runs credential-free policy tests and the canonical live staging matrix
  through a separate actor identity. The live matrix proves the accepted
  automatic, manual, operator, and docs behaviors through Discord's real
  Gateway and REST boundaries, records exact-release receipts, and leaves zero
  owned artifacts. Staging uses a separate Discord application and dedicated
  guild; absent credentials, targets, or attended authority yield UNRUN, never
  PASS. A functional PASS does not claim operational or production readiness.

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

- **LSC.APP.DISCORD.OPS-R11 Declared provider diagnostics:** Runtime diagnostics
  are content-free and best-effort through the declared Cloudflare account
  boundary. Enabled sinks, access policy, and retention are reviewable
  deployment configuration; unavailable diagnostics do not become a durable
  delivery claim. Durable Object journal records, receipts, recovery records,
  and readiness state are application data rather than telemetry and have
  independently declared lifecycles. A sentinel test injects secret and content
  values through success and failure paths and proves that provider diagnostics
  and durable operational records contain none of them.

### Must be deployable and recoverable

- **LSC.APP.DISCORD.OPS-R12 Immutable release and receipt:** A deployment runs
  an immutable Worker version identified by source revision and dependency
  lock. Its receipt records environment, release, configuration digest, actor
  identity, readiness result, functional-gate result, operational-gate result,
  deploy time, and rollback target without recording secrets or raw Discord
  object IDs.

- **LSC.APP.DISCORD.OPS-R13 Bounded rollback:** An operator can restore the
  previous known-good Worker version and configuration without rebuilding
  either. Gradual rollout and rollback preserve the singleton Durable Object
  authority, recheck gateway-aware readiness, and emit a new receipt; failure
  to restore readiness is surfaced as a failed rollback rather than success.

- **LSC.APP.DISCORD.OPS-R14 Declared Cloudflare realization:** Each environment
  is one Alchemy v2 stack realizing `LSC.APP.DISCORD.RT-R09` and declaring all
  bindings, secret slots, triggers, routes, release versions, and traffic
  policy. Alchemy remote state is authoritative; no Wrangler manifest, host
  module, or imperative deploy script may become a second IaC source.
  Cloudflare is the canonical staging host and the production host after
  admission. The retained Node host implementation is source fallback only and
  carries no deployed or ready claim. `refines: LSC.APP.DISCORD.RT-R09,
  LS.DEL.INFRA-R01, LS.DEL.INFRA-R04`

- **LSC.APP.DISCORD.OPS-R15 Isolated Discord environments:** Production and
  staging use fresh, distinct Discord applications and bot users. Production is
  installed in the existing community guild; staging uses a dedicated guild
  with no production membership and a distinct E2E Actor. Their application
  IDs, command sets, privileged-intent settings, tokens, guild membership, and
  runtime projections are disjoint. Historical application
  `1310646763505582171`, its commands, and its credentials remain untouched and
  excluded from deployment and command synchronization. The staging runtime,
  E2E Actor, and historical bot memberships all remain installed through the
  complete functional matrix. Only after Functional PASS may an operator
  uninstall the historical bot membership from the staging guild; this does not
  delete or modify the application, commands, or credentials. The purpose-scoped
  E2E Actor remains installed for recurring regression runs. Both environments
  request exactly the Gateway intents required by the runtime and receive only
  feature-required Discord permissions.

- **LSC.APP.DISCORD.OPS-R16 Authenticated administrative control:** Each
  environment exposes its typed Bot control RPC only through authenticated
  HTTPS routes whose environment-specific bearer credential is a Cloudflare
  secret binding. The runtime derives authorization from that credential and
  never accepts caller-supplied identity. There is no unauthenticated admin
  route, direct bot-token CLI fallback, or second mutation authority. `refines:
  LSC.APP.DISCORD-R08`

- **LSC.APP.DISCORD.OPS-R17 Bounded provider configuration:** Each environment
  declares the one dedicated OpenAI project identity, its own credential
  reference, standard-retention disclosure mode, and positive request/token/cost
  ceilings. Unknown projects, shared credentials, absent ceilings, alternate
  models, or claimed ZDR/residency without live verification fail startup or AI
  readiness without withdrawing basic threading readiness.

- **LSC.APP.DISCORD.OPS-R18 Two-channel staging area:** The dedicated
  `bot-staging` area contains exactly `#staging-e2e` and
  `#staging-docs-restricted` for the canonical matrix. Both are staging-only
  targets, neither is in `aiTitleChannelIds`, and matrix-created threads use
  deterministic local titles. Live AI-title proof requires a later,
  independently authorized channel and experiment.

- **LSC.APP.DISCORD.OPS-R19 Independent production gates:** Production remains
  disabled until the same release has both a functional PASS and an operational
  PASS. Operational PASS requires authoritative remote Alchemy state, externally
  verified release identity, gateway-aware readiness, gradual rollout and
  rollback proof, a CI-owned deployment path, and long-duration reconnect
  observation. Neither verdict implies the other; missing evidence keeps
  production BLOCKED rather than being reported as PASS.

## Resolved technical decisions

- Production verification is passive: identity, exact release/config digest,
  readiness, and current Gateway health; no ordinary production channel
  receives a mutation canary
  ([decision 0001](./.decisions/0001-passive-production-verification.md)).
- Cloudflare Worker plus one SQLite-backed singleton Durable Object per
  environment is the canonical staging and eventual production host, declared
  only through Alchemy v2. The Node host remains source fallback; the dev4 and
  dev4-to-Tempo realizations are superseded
  ([decision 0007](./.decisions/0007-use-cloudflare-canonical-host.md), which
  supersedes [decision 0002](./.decisions/0002-run-on-dev4.md) and
  [decision 0005](./.decisions/0005-use-best-effort-central-traces.md)).
- Production admission keeps functional and operational verdicts independent,
  and the canonical staging matrix uses the two-channel AI-off area
  ([decision 0008](./.decisions/0008-separate-rollout-evidence.md)).
- Staging retains all three bot memberships through the functional matrix,
  removes only the historical bot's guild membership after PASS, and retains
  the E2E Actor for recurring regression
  ([decision 0009](./.decisions/0009-retain-e2e-actor-membership.md), which
  amends the membership lifecycle in
  [decision 0006](./.decisions/0006-use-fresh-discord-applications.md)).
- Production and staging use fresh, disjoint Discord applications; staging also
  has a dedicated guild and E2E Actor, while the historical Molty identity stays
  untouched
  ([decision 0006](./.decisions/0006-use-fresh-discord-applications.md), which
  supersedes [decision 0003](./.decisions/0003-isolate-staging-discord-identity.md)).
