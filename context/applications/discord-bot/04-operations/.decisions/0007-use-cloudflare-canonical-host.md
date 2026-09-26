# 0007 - Use Cloudflare as the canonical deployment host

Status: accepted; supersedes
[decision 0002](./0002-run-on-dev4.md) and
[decision 0005](./0005-use-best-effort-central-traces.md)

## Context

A workerd prototype proved the selected DFX transport graph across Cloudflare's
HTTP, outbound WebSocket, and REST boundaries. The contrib application now has
a Cloudflare realization, while the proposed dev4 NixOS realization was never
activated. Keeping both as deployment targets would duplicate configuration,
secret, readiness, control, rollback, and telemetry contracts.

The Cloudflare realization still needs production-grade remote state, release
identity, gateway-aware readiness, gradual rollback, CI deployment, and
long-duration reconnect evidence. That missing evidence is an admission gate,
not a reason to retain a second canonical host.

## Decision

Use one Cloudflare Worker and one SQLite-backed singleton Durable Object per
environment as the canonical staging and eventual production realization. The
singleton Durable Object owns Action Authority and durable operational state;
Worker routes, schedules, and release versions address that one environment
actor. Declare the complete stack only with Alchemy v2, using authoritative
remote state, secret bindings, version traffic, and rollback.

Cloudflare staging is canonical immediately. Keep production disabled until the
functional and operational gates in decision 0008 both pass. Retain the Node
host implementation in contrib as source fallback, but do not maintain or claim
a live dev4 deployment. The disabled dotfiles dev4 proposal is closed rather
than merged, and reconstructing a Node deployment requires a new explicit host
decision.

Cloudflare provider diagnostics replace the superseded dev4-to-Tempo and local
systemd-journal topology. They remain content-free and best-effort; durable
receipts, recovery records, journal state, and readiness live in Durable Object
storage and are not telemetry.

Accepted 2026-08-27 after the Cloudflare prototype and staging deployment made
the single-platform ownership boundary concrete.
