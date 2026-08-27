# 0005 - Use the existing best-effort central trace path

Status: superseded by
[decision 0007](./0007-use-cloudflare-canonical-host.md)

## Context

The existing dev4 OTLP forwarder sends to dev3 without a persistent queue.
Tempo retains traces for 30 days, while Loki and Mimir use longer fleet-wide
retention and Grafana uses tailnet-trusted anonymous access. Satisfying decision
0004 literally would therefore require a durable forwarder, bot-specific log
and metric retention, and a new authenticated observability access boundary.

The bot needs enough remote evidence to diagnose lifecycle and action failures,
but those infrastructure changes are disproportionate to the initial feature
scope. Content privacy remains non-negotiable.

## Decision

Export allowlisted, content-free traces only through dev4's existing
best-effort OTLP forwarder to Tempo on dev3. Tempo's 30-day trace retention and
the fleet's existing tailnet-trusted Grafana access are accepted for initial
scope. Delivery may be lost while dev3 or the network is unavailable; neither
the bot nor the forwarder claims durable trace delivery.

Do not export bot application logs or metrics to central Loki or Mimir in
initial scope. Local service lifecycle and error logs remain in the systemd
journal under current host policy and must obey the same content allowlist, but
the bot does not claim a bot-specific journal retention or access policy.
Deployment receipts, recovery records, and thread idempotency state remain
durable application state under `/var/lib/discord-bot/` with their own schemas
and lifecycle.

Acceptance requires a sentinel leak test over emitted spans, local log records,
and durable receipts. It does not require a bot-specific LGTM tenant, Grafana
role, persistent OTLP queue, Loki stream, or Mimir series.

Accepted 2026-08-23 under the maintainer direction to keep the initial
realization simple.

## Amendment

Superseded 2026-08-27 with the dev4 host decision. The canonical Cloudflare
realization uses its declared provider diagnostic boundary; it does not route
through dev4's OTLP forwarder or systemd journal. Content privacy remains
mandatory, while durable receipts and operational state move to the singleton
Durable Object rather than telemetry.
