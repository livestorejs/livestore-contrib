# Discord Bot — Spec

This document specifies the composition boundary of the contrib-owned Discord
application. Feature and operational mechanics live in its child specs.

## Status

Draft.

**Maturity: experimental**

## Scope

The application consumes the LiveStore Discord community surface and owns four
contracts:

| Child | Owns | Does not own |
| --- | --- | --- |
| [`01-runtime`](./01-runtime/spec.md) | DFX boundary, Gateway/REST/interaction lifecycle, decoded ports | feature policy |
| [`02-threading`](./02-threading/spec.md) | automatic and explicit thread decisions/actions | Discord transport |
| [`03-docs-assistant`](./03-docs-assistant/spec.md) | explicit docs requests, canonical source, answer delivery | canonical LiveStore truth |
| [`04-operations`](./04-operations/spec.md) | identities, configuration, secrets, deployment, health, canaries | community support policy |
| [`05-cli`](./05-cli/spec.md) | operator command surface over typed application use cases | alternate business logic or direct Discord writes |

The dependency direction is:

```text
                   +------------------+
Discord Gateway -->| 01-runtime       |
                   +--------+---------+
                            |
                  +---------+----------+
                  |                    |
                  v                    v
          +---------------+    +-------------------+
          | 02-threading  |    | 03-docs-assistant |
          +-------+-------+    +---------+---------+
                  |                      |
                  +----------+-----------+
                             v
                    +----------------+
                    | 04-operations  |
                    +--------+-------+
                             |
                             v
                    +----------------+
                    | 05-cli         |
                    +----------------+
```

Runtime depends on DFX. Features depend on bot-owned runtime ports, not DFX
objects. Operations supplies configuration and durable runtime resources to all
children and verifies their live outcomes. The CLI is a sibling adapter over
the same typed use cases used by Discord handlers; it never calls DFX, SQLite,
or OpenAI directly.

## Feature provenance (LSC.APP.DISCORD-R02)

| Capability | Provenance | VRS status |
| --- | --- | --- |
| Automatic threads | merged old main | initial child scope; policy undecided |
| `Create Thread` message action | merged old main | initial child scope; authorization undecided |
| `/docs` | merged old main | initial child scope; audience/context/provider undecided |
| Member welcome batches | open, divergent PR | roadmap-only; excluded from initial scope by decision 0004 |
| GitHub issue creation | README roadmap only | out of initial scope |

## Application boundary (LSC.APP.DISCORD-R01, R03)

The runtime exposes bot-owned event streams and action services. It does not let
DFX types flow through domain policy modules. Discord IDs and decoded payloads
are validated at ingress; action requests are validated before REST calls.

```text
DFX Gateway -> DiscordEvents -> feature policy -> DiscordActions -> DFX REST
DFX Ix      -> DiscordInteractions -----------^             |
                                                             v
                                                       action outcome
```

A private implementation now exists under `apps/discord-bot`. It composes the
typed runtime, shared feature workflows, durable journal, Bot control RPC/CLI,
DFX adapters, credential-free E2E harness, and immutable Nix package described
by the child specs. The exact local tracer-bullet evidence is recorded in
[experiment 0010](./.experiments/0010-implemented-tracer-bullet.md).

This implementation is not a live realization: no isolated staging Discord
application/guild receipt or declared dev4 production deployment has passed.
That remaining drift stays open in
[DELTA-001](./.delta/DELTA-001-application-not-implemented.md), and the
cross-repository build and acceptance sequence remains recorded in the
[implementation plan](./.reference/implementation-plan.md).
