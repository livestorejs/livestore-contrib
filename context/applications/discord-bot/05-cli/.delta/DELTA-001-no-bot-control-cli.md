# DELTA-001 - Bot control CLI lacks live runtime proof

Status: open

## Divergence

No exact-release receipt yet proves the CLI against a live Discord source
message through Cloudflare staging's authenticated HTTPS control route.

## VRS

The CLI spec requires stateful commands to route through the active runtime,
derive identity from transport authentication, share feature authorization and
receipts, and avoid direct credential fallback.

## Implementation

The private application defines all 16 Bot control operations, mappings,
mutation guards, and structured output. Historical source-level black-box
evidence proves plan/create/repeat/status/docs/readiness through the retained
Node Unix-RPC adapter. Cloudflare exposes `/admin/rpc/`, while the standalone
live runner and harness-model matrix do not substitute for runtime RPC parity.
See [experiment 0010](../../.experiments/0010-implemented-tracer-bullet.md).

## Direction

update implementation

## Resolution Signal

Staging proves a retroactive `thread create`, repeated `AlreadySatisfied`,
receipt, and owned cleanup through the active Cloudflare runtime.
`StagingE2ERun` remains UNRUN without staging authority and never falls back to
direct credentials.
