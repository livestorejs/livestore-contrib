# 0004 - Forward content-free telemetry to central LGTM

Status: superseded by
[decision 0005](./0005-use-best-effort-central-traces.md)

## Context

Operators need lifecycle, action, and failure evidence without turning Discord
content or AI prompts into an observability dataset. dev4 already participates
in the fleet's central telemetry topology; running a second LGTM stack on the
bot host would add state and operational ownership without improving the bot's
contract.

## Decision

Emit allowlisted, content-free OpenTelemetry data through dev4's local durable
OTLP forwarder to the central dev3 LGTM stack over Tailscale. Do not run a bot
telemetry backend on dev4. Access is restricted to the bot's operational owner
group, and bot logs, traces, and metrics have a 30-day maximum retention.

Deployment receipts, recovery records, and thread idempotency state are
operational state under `/var/lib/discord-bot/`, not telemetry. They receive
their own schemas and retention rules. Production admission requires a sentinel
leak test and proof that the backend enforces the bot-specific access and
retention policy rather than silently inheriting a broader default.

Accepted 2026-08-23.

Superseded 2026-08-23 after the implementation audit showed that the existing
dev4 forwarder is best-effort, central Loki and Mimir retain data longer than
30 days, and Grafana uses the fleet's tailnet-trusted access boundary. Decision
0005 narrows the initial contract to the existing trace path instead of adding
a bot-specific observability plane.
