# DELTA-001 - Protected runtime requirements lag the Cloudflare realization

Status: open

## Divergence

The context in [`requirements.md`](../requirements.md) says no product
implementation exists, while the private application has both Cloudflare and
retained Node source realizations. RT-R09 still mandates a Nix-managed systemd
service and host-local lock on dev4, while the accepted canonical host and
current staging implementation use a Cloudflare Worker plus singleton Durable
Object.

## VRS

RT-R09 is protected. The confirmation that authorized the Cloudflare host
amendment applied to
[`04-operations/requirements.md`](../../04-operations/requirements.md), not this
runtime requirements file. The accepted operations
[host decision](../../04-operations/.decisions/0007-use-cloudflare-canonical-host.md)
therefore discloses real drift rather than silently authorizing a second
protected edit.

## Implementation

`apps/discord-bot` implements the DFX runtime and canonical Cloudflare staging
host. The retained Node implementation is source fallback only; it does not
make dev4 a deployed, ready, or live host. Cloudflare staging reachability does
not claim production admission.

## Direction

decide

## Resolution Signal

A maintainer separately confirms amendment of the protected runtime
requirements. That amendment replaces the no-implementation context and the
dev4/systemd realization in RT-R09 with the truthful Cloudflare singleton
contract while retaining Node as source fallback. This delta can then be
removed without claiming production readiness.
