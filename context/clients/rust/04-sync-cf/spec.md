# Rust Client sync-cf — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Transports

`transport.rs` speaks Effect RPC over WebSocket text frames (`Request`, `Ack`,
`Chunk`, `Exit`, `Ping`/`Pong`); `http.rs` speaks the HTTP transport. Both feed a
`SyncBackend` (see [03-leader](../03-leader/spec.md)). `pull_policy.rs` owns
live-pull bookkeeping.

## Duplicate Live Pages

The backend drops live pull events at or below the last one it emitted. After a
`ServerAheadError` on the same socket the Durable Object sends a live page twice,
and the TS leader merge would reject that page.

## Verification

`rust/scripts/test-live.sh` runs the transport, sync-loop, ported
sync-provider, hibernation, and Rust ⇄ TypeScript e2e tests against the pinned
core's test worker; without `LIVESTORE_SYNC_URL` those tests skip.
`tests/sync_fake.rs` covers the sync loop against an in-process scripted backend.
