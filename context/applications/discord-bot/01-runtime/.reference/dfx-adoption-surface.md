# DFX adoption surface

Snapshot date: 2026-08-23
Upstream revision inspected:
[`23988a4f`](https://github.com/tim-smart/dfx/tree/23988a4f182eb5cebc6c3bbac3f3c35fd303168f)

This is a source map for the adopted dependency boundary, not a fork plan.

| Concern | DFX surface | Bot ownership |
| --- | --- | --- |
| Configuration and intents | `DiscordConfig` | Select exact intents and supply secret configuration |
| Typed server events | `DiscordGateway.fromDispatch` / `handleDispatch` | Feature subscriptions and policy |
| Heartbeat, identify, resume, sequence | Gateway shard/session layers | Supervision and readiness projection |
| Discord HTTP API | Generated `DiscordREST` methods | Narrow action ports and operation authorization |
| Rate limits | DFX REST rate limiter | Avoid bypass clients; expose operational failure |
| Commands/interactions | DFX interactions registry and Gateway transport | Command definitions and authorization |
| WebSocket transport | Node WebSocket layer | Supply platform layer and lifecycle scope |
| Close classification | Incomplete in inspected revision | Upstream-first repair and admission test |

The inspected package is version `1.0.15`, declares
`effect >=4.0.0-beta.101 <5.0.0`, and uses `discord-api-types` for Discord
protocol types. Version facts are a dated snapshot and must be refreshed when
the dependency is admitted.

Primary protocol reference:
[Discord Gateway opcodes and status codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes).
