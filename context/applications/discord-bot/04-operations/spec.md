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
  readonly telemetry: {
    readonly sink: 'dev3-tempo'
    readonly delivery: 'best-effort'
    readonly accessBoundary: 'tailnet-trusted-grafana'
    readonly retentionDays: 30
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
overlap staging-only or declared private/moderator targets. Docs audience
channels and roles must resolve inside the declared guild; the two channel sets
are disjoint, and a role-restricted channel set requires at least one declared
contributor/maintainer role. Production
decoding rejects any member also listed in `stagingOnlyChannelIds`. Secret
references identify a provider-owned secret slot; their URI/grammar is owned by
the selected deployment controller and cannot contain the resolved value.

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

## Host and Authority Realization

The deployment target is dev4. One dedicated systemd unit and service user per
environment runs the contrib-built immutable artifact. Dotfiles owns the NixOS
module, `deploy-rs` activation, `op-proxy` credential projection, health
observation, host state permissions, and rollback integration. Contrib owns the
artifact, configuration decoder, health semantics, and deployment receipt
schema.

Before opening a Gateway connection, the unit acquires an environment-specific
host-local Action Authority lock. Deployment stops the old unit and observes
lock release before the candidate may acquire it. systemd restart policy may
replace a failed process, but it may not run a parked candidate that is already
connected. Mutable runtime state lives below
`/var/lib/discord-bot/<environment>/` and is not shared with other dev4
applications.

Each environment also owns a Unix-domain administrative socket below
`/run/discord-bot/<environment>/control.sock`. The dedicated service and
`discord-bot-operators` group are its only peers. The runtime derives operator
identity/capabilities from the authenticated peer and never accepts an identity
assertion from RPC input. Remote operators run `livestore-discord` through SSH
on dev4; no public administrative listener or direct credential fallback is
initial scope.

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
withdraws readiness synchronously. Process liveness is a separate deployment
controller signal. The chosen platform exposes both signals externally and
alerts when production remains non-ready beyond its declared startup/reconnect
budget (R05-R06).

DFX owns socket/session mechanics. The integration must classify Discord fatal
close codes 4004, 4010, 4011, 4012, 4013, and 4014 as terminal before applying
any reconnect schedule. Until upstream DFX provides and verifies that behavior,
the production dependency pin carries a tested adapter or upstream patch rather
than accepting an unbounded reconnect loop.

## Telemetry and Privacy

```text
Discord input -> policy/action -> structured outcome
      |                              |
      +-- content boundary           +--> approved trace fields
                                           |
                                           v
                              best-effort OTLP -> Tempo (30d)

service lifecycle/errors -> content-free systemd journal (host policy)
receipts/recovery/state  -> /var/lib/discord-bot (owned lifecycle)
```

The trace and log encoders use an explicit content allowlist. Permitted common fields are
`service.name`, environment, release ID, event class, handler name, policy
outcome, duration, retry count, Discord error class/code, lifecycle state, and
a run-scoped one-way correlation value. Message text, prompts, generated text,
docs excerpts, tokens, usernames, and raw Discord IDs have no encoder fields.
Unknown error causes are rendered as a stable error class plus redacted summary,
not serialized recursively (R10).

The bot exports content-free traces only to dev4's existing local OTLP
forwarder, which sends over Tailscale to Tempo on dev3. Forwarding is
best-effort: the current path has no persistent queue, so an unavailable network
or sink may lose traces. Tempo retains traces for 30 days. Operators inspect
them through the fleet's existing tailnet-trusted Grafana boundary; initial
scope does not introduce a bot-specific tenant or Grafana role (R11).

Bot application logs and metrics are not exported to central Loki or Mimir in
initial scope. Process lifecycle and error records remain in the local systemd
journal under current dev4 host retention and access policy. They must be
content-free, but the bot makes no bot-specific durability, retention, or access
claim for the journal. A privacy test passes unique sentinels as a token,
message, prompt, generated answer, and thrown-error detail through success and
failure paths, captures emitted spans, local log records, and receipts, and
fails if any sentinel occurs (R10-R11).

Deployment receipts, recovery records, and idempotency state are application
state rather than telemetry. Their schemas and retention are independently
declared under the environment state directory.

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

The staging-live gate runs in a dedicated staging guild through a staging bot
and a distinct E2E Actor. It executes this sequence (R07-R09):

1. Require an explicit live-write flag and confirmation value before resolving
   credentials.
2. Resolve exact guild/channel IDs, fetch the channel, and verify its guild,
   allowlist membership, and purpose marker.
3. Have the separate E2E Actor post a unique marker whose run correlation is
   known to the harness; staging policy accepts that actor only in this target.
4. Observe exactly one resulting thread. Discord's thread ID must equal the
   source message ID, and its guild and parent channel must match the target.
5. Delete the correlated thread, then the marker. Never delete a candidate that
   fails any ownership check.
6. Emit PASS only after cleanup. Timeout attempts marker cleanup; cleanup
   failure emits FAIL plus a sanitized recovery receipt. Missing credentials or
   target configuration emits UNRUN.

Production verification compares the running release/configuration digest to
the deployment receipt, reads the external readiness signal, verifies the
declared identity, and requires a healthy current Gateway session. It performs
no Discord mutation in the initial rollout.

## Deploy and Rollback

```text
build immutable release -> simulated gate -> staging-live gate
                                              |
                                              v
                                      stop old authority
                                              |
                                      start candidate
                                              |
                                ready + production verify
                                   | fail              | pass
                                   v                   v
                           stop candidate          receipt
                                   |
                         start rollback target
                                   |
                         readiness + rollback receipt
```

Before a production deploy, the controller records the current release and
configuration digest as the Rollback Target. It admits a candidate only when
its policy tests and live staging E2E pass against the same immutable release.
It then removes Action Authority from the old instance before starting the
candidate. No blue/green overlap is permitted (R04, T01).

A successful Deployment Receipt contains environment, source/release ID,
dependency-lock digest, configuration digest, verified application identity in
sanitized form, policy-test verdict, staging-live E2E verdict and receipt ID,
production readiness verdict, deploy time, and Rollback Target. It contains no
resolved secret or raw Discord object ID (R12).

Rollback stops the candidate, launches the recorded artifact with the recorded
configuration, and reruns identity/readiness verification. A rollback receipt
is emitted regardless of outcome. Only restored readiness is `PASS`; process
start without readiness is `FAIL` (R13).

## Operational Divergence

No owned running realization currently satisfies this spec. The evidence and
close conditions are recorded in
[DELTA-001](./.delta/DELTA-001-no-owned-runtime.md). Historical telemetry also
crossed the content-privacy boundary; see
[DELTA-002](./.delta/DELTA-002-content-bearing-telemetry.md).
