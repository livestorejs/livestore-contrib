# Discord Bot Runtime — Spec

Specifies the target Discord host and protocol boundary. Builds on
[requirements.md](./requirements.md) and uses the language in
[ontology.md](./ontology.md). Source realization is not a production verdict.

## Status

Draft.

## Runtime Boundary

The application runtime is an Effect layer graph with DFX as the only Discord
protocol implementation:

```text
Discord Gateway
      |
      v
DFX Gateway + session lifecycle -----> runtime health
      |
      v typed dispatch
feature handler -----> Discord action port -----> DFX REST -----> Discord API
                              |
                              `---- recording fake (tests)
```

The canonical Cloudflare graph provides:

1. `DiscordConfig` with the bot token and exactly the intents in
   LSC.APP.DISCORD.RT-R03;
2. global Fetch HTTP and WebSocket transports required by DFX;
3. DFX Gateway, REST, rate-limit, and interactions services;
4. feature-handler layers consuming typed Gateway dispatches;
5. narrow Discord action-port implementations delegating to DFX REST; and
6. a health projection derived from Gateway session state and terminal failure.

Worker fetch and scheduled ingress address one fixed Durable Object name per
environment. That singleton owns Gateway supervision, mutation authority,
health, the resumable session, the action journal, and validated runtime
configuration. Gradual Worker version overlap cannot create a second Gateway
actor because every version reaches the same environment object. The runtime
does not implement active/active leases.

After an isolate or release restart, the object validates its durable state
before connecting or admitting mutation. It resumes a valid persisted session
or establishes the one replacement session, then reconciles the durable journal
before accepting new actions. Missing, invalid, or unreconciled recovery state
keeps the runtime not ready and fails closed rather than starting an
uncoordinated actor.

[Operations](../04-operations/requirements.md) realizes this boundary through
the canonical Alchemy v2 Cloudflare stack and independently owns production
admission. The Node graph remains buildable fallback source with its Node
HTTP/WebSocket transports; it is not a running dev4 service or parallel
production topology. The host history is retained by
[Cloudflare decision 0007](../04-operations/.decisions/0007-use-cloudflare-canonical-host.md)
and its superseded
[dev4 decision 0002](../04-operations/.decisions/0002-run-on-dev4.md).

Feature nodes own message eligibility, thread naming, command authorization,
and response content. This node owns only their Discord transport, lifecycle,
and side-effect boundary.

## Gateway Configuration

The initial identify intent bitset is exactly:

```text
GatewayIntentBits.Guilds
| GatewayIntentBits.GuildMessages
| GatewayIntentBits.MessageContent
```

The first two intents expose guild/message dispatch context.
`MessageContent` is required because auto-thread eligibility and naming inspect
the source message body. The runtime does not request `GuildMembers`, presence,
voice, or direct-message intents in initial scope.

The topology uses one runtime, one shard, and one active Gateway session.
Configuration may retain DFX's shard abstraction, but initial deployment must
not start multiple active shards or replicas implicitly.

## Connection State

```text
starting -> connecting -> ready
               ^           |
               |           +-- transient close --> reconnect/resume
               |
               +----------------------------------+

ready/connecting -- terminal close --> failed (not ready; no retry loop)
```

`ready` begins only after Discord identifies the session (a `READY` dispatch or
successful resume). A transient interruption clears readiness until reconnect
or resume succeeds. A terminal close exits the retry schedule, records a
failure suitable for diagnosis, and causes the supervised runtime to fail.

The terminal set initially follows Discord's documented non-reconnectable
configuration/authentication failures:

| Code | Meaning | Runtime action |
| --- | --- | --- |
| `4004` | Authentication failed | Stop and fail |
| `4010` | Invalid shard | Stop and fail |
| `4011` | Sharding required | Stop and fail |
| `4012` | Invalid API version | Stop and fail |
| `4013` | Invalid intent(s) | Stop and fail |
| `4014` | Disallowed intent(s) | Stop and fail |

Other Discord close codes follow DFX's resume/reconnect behavior unless the
protocol classification is revised with evidence. The selected application
artifact carries the narrowly fenced DFX 1.0.15 patch accepted by decision
0002. Its terminal/transient differential and runtime failure propagation are
recorded in
[experiment 0010](../.experiments/0010-implemented-tracer-bullet.md). An
upstream release remains preferable, but is no longer an unproven application
gap for the selected artifact.

## Handler and Action Ports

Handlers subscribe through DFX's typed dispatch API rather than decode raw
WebSocket values themselves. Every handler is supervised within the application
runtime's scope so shutdown releases its subscription fibers and DFX resources.

Outbound effects cross named, narrow ports based on product operations (for
example, creating a thread from one source message). Production implementations
translate those requests to generated DFX REST methods. Tests provide recording
fakes that preserve request data and allow assertions about zero, one, or
repeated actions. Handler tests must not need a bot token.

This injection seam does not validate Discord itself. A separate, explicitly
write-enabled staging harness must prove Gateway-to-REST behavior against a
dedicated Discord target before production acceptance.

## Dependency Admission

The bot may adopt DFX only with one lock-coherent Effect line. Admission checks
must include:

- frozen installation from a clean checkout;
- peer-dependency resolution without incompatible Effect versions;
- strict application typecheck;
- the credential-free Gateway/handler suite;
- terminal-close classification tests against the actual selected DFX build;
  and
- a deliberate assertion of the resolved DFX, Effect, Node platform, and
  platform-shared versions.

The contrib root still pins Effect beta.98 while `dfx@1.0.15` declares Effect
`>=4.0.0-beta.101 <5.0.0`. The private `apps/discord-bot` workspace therefore
uses the isolated dependency boundary recorded in
[decision 0001](./.decisions/0001-isolated-effect-graph.md) and the exact
beta.105 baseline in
[decision 0003](./.decisions/0003-pin-validated-dfx-graph.md). The frozen
application graph and immutable package are locally admitted; live Discord
identity/session behavior remains part of staging acceptance.

## Initial Non-Goals

- horizontal scaling, multi-shard operation, or distributed leader election;
- replacing DFX's Gateway, REST, rate limiting, or interactions stack;
- defining feature-level message/thread policy;
- claiming exactly-once Gateway delivery; and
- treating credential-free simulation as a live Discord E2E verdict.
