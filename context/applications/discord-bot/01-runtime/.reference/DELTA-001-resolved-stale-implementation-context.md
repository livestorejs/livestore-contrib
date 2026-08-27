# DELTA-001 - Protected runtime requirements lagged the Cloudflare realization

Source: Maintainer-authorized protected RT-R09 amendment (Axe q30 answer
`38aulx`) and repository implementation evidence, 2026-08-27.

## Relevant Facts

Before resolution, [`requirements.md`](../requirements.md) said no product
implementation existed even though the private application had Cloudflare and
retained Node source realizations. RT-R09 still mandated a Nix-managed systemd
service and host-local lock on dev4 after the accepted canonical host had become
a Cloudflare Worker plus singleton Durable Object.

[`apps/discord-bot/cf/alchemy.run.ts`](../../../../../apps/discord-bot/cf/alchemy.run.ts)
declares the canonical remote Cloudflare stack.
[`cf/src/bot-state.ts`](../../../../../apps/discord-bot/cf/src/bot-state.ts)
implements the singleton Durable Object that owns Gateway supervision, session
state, journal, configuration, and readiness. The Node implementation remains
source fallback only. These source facts do not claim production admission.

## Resolution

The maintainer authorized amendment of the protected runtime requirements on
2026-08-27. The runtime requirements context now distinguishes implemented
source and staging reachability from production admission. RT-R09 now requires
one SQLite-backed singleton Durable Object per environment, durable
session/journal/configuration ownership, and fail-closed restart, resume, and
reconciliation.

[`spec.md`](../spec.md) defines the corresponding recovery sequence and links
[Cloudflare decision 0007](../../04-operations/.decisions/0007-use-cloudflare-canonical-host.md)
with superseded
[dev4 decision 0002](../../04-operations/.decisions/0002-run-on-dev4.md), which
preserves the replaced host history.

## VRS Impact

DELTA-001 is closed because the protected VRS and implementation now agree on
the canonical host contract. Remaining functional and production-admission
drift stays in its owning parent and Operations delta records; it is not runtime
requirement drift. This resolved record remains as historical evidence rather
than an open `.delta` entry.
