# 0002 - Route CLI writes through the active runtime

Status: accepted; transport amended by the operations
[host decision](../../04-operations/.decisions/0007-use-cloudflare-canonical-host.md)

## Context

Direct CLI use of the bot token and SQLite file would create a second mutation
authority, race the Gateway runtime, and allow repairs to evade the action
journal. A public admin endpoint would unnecessarily expand the trust boundary.

## Decision

Stateful CLI commands use an authenticated administrative RPC connection to the
active environment runtime. Initial transport is an environment-specific Unix
socket on dev4, reached remotely through the fleet's authenticated SSH path.
Socket peer identity supplies the operator; flags cannot override it. No direct
credential fallback or public admin listener exists.

Accepted 2026-08-23.

## Amendment

The active runtime now exposes authenticated HTTPS `/admin/rpc/` routes through
the canonical Cloudflare Worker. The environment-specific bearer credential is
a secret binding and supplies the authorization boundary; request input cannot
override identity. Direct bot-token fallback remains forbidden. The original
Unix-socket/dev4 transport was never activated and is superseded.
