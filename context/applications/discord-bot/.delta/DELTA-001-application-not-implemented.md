# Delta 001 — The contrib-owned Discord application is not production-live

Status: open

## Divergence

The contrib application has a canonical Cloudflare staging host, but it is not
production-live and lacks complete exact-release functional and operational
evidence.

## VRS

The parent requirements demand truthful capability claims. The operations
requirements define independent functional and operational verdicts and forbid
production until both pass for the same release.

## Implementation

`apps/discord-bot` realizes the local application composition, retained Node
fallback, and Alchemy-declared Cloudflare Worker plus singleton Durable Object.
Its local evidence is recorded in
[experiment 0010](../.experiments/0010-implemented-tracer-bullet.md).
A reachable staging runtime does not prove the full live matrix or production
operations.

## Direction

update implementation

## Resolution Signal

The staging matrix passes all automatic, manual, operator, and docs lanes with
zero owned artifacts; the same release passes authoritative remote Alchemy
state, release identity, gateway-aware readiness, gradual rollback, CI deploy,
and long-duration reconnect proof; and production captures passive
exact-release identity/readiness plus sanitized deployment and rollback
receipts. Missing evidence remains UNRUN or BLOCKED, never local PASS.
