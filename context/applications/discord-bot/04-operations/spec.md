# Discord Bot Operations - Spec

This document specifies the operational boundary for the LiveStore Discord bot.
It builds on [requirements.md](./requirements.md) and the parent application
[spec](../spec.md).

## Status

Draft.

## Scope

This node defines deployment identity, configuration and credential boundaries,
runtime lifecycle, health, privacy-safe telemetry, live E2E proof, deployment,
and rollback. Feature policy, thread naming, docs answers, and command UX belong
to sibling nodes.

## Deployment Contract

```text
BotDeploymentConfig --decode--> validated config
SecretRef ----------resolve--> Credential Projection
ImmutableRelease -------------> runtime
                                      |
Discord REST <---------- DFX ---------+---------> Discord Gateway
                                      |
                               RuntimeHealth
```

Each environment supplies one `BotDeploymentConfig` through the deployment
controller. The shape is normative even when its serialized representation is
platform-specific:

```ts
interface BotDeploymentConfigBaseV1 {
  readonly schemaVersion: 1
  readonly environment: 'staging' | 'production'
  readonly applicationId: DiscordSnowflake
  readonly guildId: DiscordSnowflake
  readonly actionChannelIds: ReadonlyArray<DiscordSnowflake>
  readonly aiTitleChannelIds: ReadonlyArray<DiscordSnowflake>
  readonly docsAudience: {
    readonly publicChannelIds: ReadonlyArray<DiscordSnowflake>
    readonly roleRestrictedChannelIds: ReadonlyArray<DiscordSnowflake>
    readonly contributorMaintainerRoleIds: ReadonlyArray<DiscordSnowflake>
  }
  readonly stagingOnlyChannelIds: ReadonlyArray<DiscordSnowflake>
  readonly botTokenSecretRef: SecretRef
  readonly openAi: {
    readonly projectId: string
    readonly serviceAccountSecretRef: SecretRef
    readonly retentionPosture: 'standard-store-false'
    readonly limits: {
      readonly requestsPerMemberPerHour: number
      readonly requestsPerMinute: number
      readonly inputTokensPerRequest: number
      readonly outputTokensPerRequest: number
      readonly monthlyCostUsdMicros: number
    }
  }
  readonly releaseId: string
  readonly diagnostics: {
    readonly sink: 'cloudflare-provider'
    readonly delivery: 'best-effort'
    readonly retentionDays: number
    readonly accessPolicyId: string
  }
}

type BotDeploymentConfigV1 =
  | (BotDeploymentConfigBaseV1 & {
      readonly environment: 'production'
    })
  | (BotDeploymentConfigBaseV1 & {
      readonly environment: 'staging'
      readonly e2e: {
        readonly actorApplicationId: DiscordSnowflake
        readonly actorTokenSecretRef: SecretRef
        readonly targetChannelId: DiscordSnowflake
        readonly requiredPurposeMarker: string
      }
    })
```

`DiscordSnowflake` is the canonical decimal string form accepted by Discord;
numeric JSON values are invalid because they can lose precision. IDs are
deduplicated during decoding. `actionChannelIds` must be non-empty.
`aiTitleChannelIds` must be a subset of public `actionChannelIds` and cannot
overlap staging-only or declared private/moderator targets. The canonical
staging configuration declares exactly `#staging-e2e` and
`#staging-docs-restricted` as its two matrix channels and declares an empty
`aiTitleChannelIds`; its thread titles are deterministic. Docs audience
channels and roles must resolve inside the declared guild; public and
role-restricted channel sets are disjoint, and a role-restricted set requires
at least one declared contributor/maintainer role. Production decoding rejects
any member also listed in `stagingOnlyChannelIds`. Secret references name
Alchemy-declared Cloudflare secret bindings and cannot contain resolved values.

The immutable release includes source revision, lockfile, application code,
and runtime dependencies. It excludes environment configuration and projected
credentials. Production and staging declare fresh, distinct Discord
applications; staging also uses a dedicated guild. Historical application
`1310646763505582171` is a forbidden deployment and command-sync target because
it currently owns Molty/Clawdbot global commands. At startup the runtime
resolves the token, calls Discord's current bot/application identity endpoint,
and rejects an `applicationId` mismatch, an environment-identity collision, or
the reserved historical ID before opening mutation handlers (R01-R04, decision
0006).

The staging guild keeps three bot memberships through the full functional
matrix: the staging runtime bot, the historical bot, and the E2E Actor. Matrix
setup and execution never read the historical credential or modify its
application, bot user, commands, or credentials. After Functional PASS and its
zero-artifact receipt, an operator removes only the historical bot's membership
from the staging guild. The historical application remains intact and
unmodified. The purpose-scoped E2E Actor remains installed so recurring
regression runs retain the same independent author and cleanup authority (R15;
decision 0009).

## Host and Authority Realization

```text
                      Alchemy v2 stack
                            |
              +-------------+-------------+
              |                           |
              v                           v
Cloudflare Worker                   secret bindings
 fetch / scheduled                       |
              |                           |
              +------------+--------------+
                           v
             BotState("gateway")
             singleton Durable Object
              |       |         |
              |       |         +-- RuntimeHealth
              |       +------------ Gateway supervisor/session
              +-------------------- SQLite journal + receipts
```

Each environment is one Alchemy v2 stack. It declares the Worker, one
SQLite-backed `BotState` Durable Object binding, secret slots, schedule, routes,
release versions, binary rollout policy, and authoritative remote state.
Alchemy is the only IaC source: a Wrangler manifest, host module, or imperative
deploy script may not independently define the stack.

All fetch routes, schedules, and release versions address the fixed Durable
Object name `gateway` inside their environment stack. That object owns Action
Authority, Gateway supervision, runtime health, durable journal and receipts,
and environment state. A release change replaces the code addressing that
singleton as one binary deployment. Percentage traffic does not exercise a
second bot actor and is not a bot canary. Production and staging have disjoint
Workers, Durable Objects, storage, configuration, and secret projections; no
state or credential crosses the environment boundary.

The Worker exposes the typed Bot control RPC below `/admin/rpc/` over HTTPS.
Every request requires the environment-specific bearer credential from an
Alchemy-declared Cloudflare secret binding. The runtime derives authorization
from the validated credential, not request-body identity. `/readyz` is the
minimal public health route and reads the singleton's current health. No
unauthenticated admin route or direct bot-token fallback exists.

The Node host implementation remains buildable source fallback. It is not a
deployed environment, a maintained second IaC topology, or evidence of current
readiness. Reintroducing dev4 or another Node deployment requires a new host
decision (R04, R14, R16; decision 0007).

## Runtime Lifecycle and Readiness

```text
starting --config+identity+REST+READY+handlers--> ready
   |                                               |
   | invalid config / fatal close                  | Gateway lost
   v                                               v
terminal <------------------------------------- degraded
   ^                                               |
   +---------------- fatal close ------------------+
                      transient reconnect -> ready
```

The runtime maintains one `RuntimeHealth` snapshot:

```ts
interface RuntimeHealth {
  readonly state: 'starting' | 'ready' | 'degraded' | 'terminal'
  readonly environment: 'staging' | 'production'
  readonly releaseId: string
  readonly identityVerified: boolean
  readonly restProbe: 'pending' | 'ok' | 'failed'
  readonly gateway: 'connecting' | 'ready' | 'disconnected' | 'fatal'
  readonly handlersRegistered: boolean
  readonly lastGatewayActivityAt?: string
  readonly terminalErrorClass?: string
}
```

`ready` is derived, never manually set: identity is verified, REST probe is
`ok`, Gateway is `ready`, and handlers are registered. Losing any condition
withdraws readiness synchronously. Worker availability is a separate platform
signal. `/readyz` reads the singleton Durable Object snapshot and returns only
the readiness verdict, release identity, and non-content lifecycle fields. The
operational gate independently probes Worker reachability, exact release
identity, and current Gateway readiness (R05-R06).

DFX owns socket/session mechanics. The integration must classify Discord fatal
close codes 4004, 4010, 4011, 4012, 4013, and 4014 as terminal before applying
any reconnect schedule. Until upstream DFX provides and verifies that behavior,
the production dependency pin carries a tested adapter or upstream patch rather
than accepting an unbounded reconnect loop.

## Diagnostics and Durable Operational State

```text
Discord input -> policy/action -> allowlisted diagnostic outcome
      |                              |
      +-- content boundary           +--> Cloudflare provider diagnostics

gateway/session/journal/status -> singleton Durable Object storage
deployment/version/state       -> Alchemy remote state + receipts
```

The diagnostic encoder uses an explicit content allowlist. Permitted common
fields are `service.name`, environment, release ID, event class, handler name,
policy outcome, duration, retry count, Discord error class/code, lifecycle
state, and a run-scoped one-way correlation value. Message text, prompts,
generated text, docs excerpts, tokens, usernames, and raw Discord IDs have no
encoder fields. Unknown error causes are rendered as a stable error class plus
redacted summary, not serialized recursively (R10).

Runtime diagnostics use only the Cloudflare sink and access boundary declared
by the environment stack. Delivery is best-effort; provider or network loss may
drop records. The stack declares the enabled sink, retention, and access-policy
identifier so review does not infer those properties from defaults. There is
no dev4 OTLP hop, systemd journal, bot-specific Loki/Mimir stream, or durable
diagnostic-delivery claim (R11; decision 0007).

Gateway session state, action journal entries, deployment and rollback
receipts, recovery records, and readiness snapshots are durable operational
data in the singleton Durable Object, not telemetry. Alchemy infrastructure
metadata uses authoritative remote state. Each data class declares its own
lifecycle.

A privacy test passes unique sentinels as a token, message, prompt, generated
answer, and thrown-error detail through success and failure paths, captures
provider diagnostics and durable operational records, and fails if any sentinel
occurs (R10-R11).

## Live E2E Protocol

```text
E2E Actor        Discord          Bot Deployment        E2E harness
    | marker        |                    |                    |
    +-------------->| MESSAGE_CREATE     |                    |
                    +------------------->|                    |
                    |<------ thread -----+                    |
                    |                    |                    |
                    +------------------------------ observe ->|
                    |<---------------- delete owned artifacts-+
                    |                    |                    |
                    +------------------------------ receipt -->
```

The functional gate runs the canonical eleven-lane matrix in the dedicated
staging guild through the staging bot and a distinct E2E Actor. The runtime bot,
historical bot, and E2E Actor all remain members until the matrix reaches
Functional PASS; membership cleanup happens only afterward. The `bot-staging`
area has exactly `#staging-e2e` and `#staging-docs-restricted`; both are
staging-only, neither enables AI titles, and every matrix-created thread
receives a deterministic local title. A later AI-title experiment requires a
separately authorized channel outside this matrix (R07-R08, R15, R18; decisions
0008-0009).

Each mutating lane follows this protocol:

1. Require an explicit live-write flag and confirmation value before resolving
   credentials.
2. Resolve exact guild/channel IDs, fetch the channel, and verify its guild,
   allowlist membership, and purpose marker.
3. Have the separate E2E Actor post or invoke the lane's unique correlated
   stimulus; staging policy accepts that actor only in declared targets.
4. Observe the exact expected automatic, manual, operator, or docs outcome and
   bind it to the tested release.
5. Delete only artifacts whose ownership and run correlation both match.
6. Emit PASS only after the zero-artifact oracle succeeds. Timeout attempts
   cleanup; cleanup failure emits FAIL plus a sanitized recovery receipt.
   Missing credentials, target configuration, or attended authority emits
   UNRUN.

The resulting Functional Verdict proves Discord behavior and cleanup only. It
does not claim remote-state safety, production readiness, or rollback. Passive
production verification separately compares running release/configuration
digests to the deployment receipt, reads `/readyz`, verifies the declared
identity, and requires a healthy current Gateway session without Discord
mutation.

## Deploy, Admission, and Rollback

```text
       immutable release in staging
                    |
                    v
       staging candidate environment
          |                   |
          v                   v
 functional gate       operational gate
 11 lanes + zero       remote state + release/readiness
 artifacts             + CI + binary deploy/redeploy + duration
          |                   |
          +------ both PASS --+
                    |
                    v
     same release identity and artifact
                    |
                    v
        binary production deployment
   (disjoint app / Worker / DO / secrets)
              | pass       | fail
              v            v
           receipt    schema/API compatible?
                         | yes       | no
                         v           v
               redeploy known-good  disable Gateway
                      code          + forward fix
```

Alchemy v2 deploys the immutable release to staging, the only candidate
environment, from authoritative remote state. The staging receipt binds the
Worker version to source/release ID, dependency-lock digest, configuration
digest, sanitized application identity, and previous known-good Rollback Target
(R12).

Functional and Operational Verdicts are independent records for that exact
staging release. Functional PASS requires all eleven live matrix lanes and zero
owned artifacts. Operational PASS requires remote Alchemy state, externally
verified release identity, gateway-aware readiness, binary deployment and
backward-compatible known-good code redeploy proof, a CI-owned deploy path, and
long-duration reconnect observation. Production remains disabled if either
verdict is absent, FAIL, BLOCKED, or UNRUN (R19; decisions 0008 and 0010).

After both verdicts pass, Alchemy deploys the same immutable release identity
and artifact to production without rebuilding. This is one binary change for
the production Worker and its singleton Durable Object, not a percentage
traffic ramp. Production has its own Discord application, Worker, Durable
Object storage, configuration, and secret projection. A percentage split would
only divide requests to the singleton bot deployment; it neither creates an
independent bot candidate nor qualifies as canary evidence. Verification checks
the exact release/configuration, declared identity, Worker reachability, and
gateway-aware `/readyz`. A successful Deployment Receipt records both gate
verdicts and the Rollback Target without secrets or raw Discord IDs.

Rollback is a binary redeploy of the recorded known-good Worker code without
rebuilding. It is allowed only when the deployed Durable Object schema and
administrative/runtime APIs remain backward compatible with that code. It does
not rewind Durable Object state, environment configuration, schemas, or API
contracts. The redeploy preserves singleton authority, reruns exact-release and
gateway-aware readiness verification, and always emits a rollback receipt. Only
restored readiness is `PASS`; a reachable Worker without a healthy Gateway is
`FAIL`.

Once an incompatible Durable Object migration or API contract is active, old
code is not a valid Rollback Target. The operator keeps the Gateway disabled
and deploys a forward fix rather than running the known-good release against
incompatible state (R04, R09, R13; decision 0010).

## Operational Divergence

Cloudflare staging is the canonical live realization, but the full functional
matrix and production operational gate remain independently open. Current
evidence and close conditions are recorded in
[DELTA-001](./.delta/DELTA-001-no-owned-runtime.md). Historical content-bearing
telemetry remains a separate privacy boundary; see
[DELTA-002](./.delta/DELTA-002-content-bearing-telemetry.md).
