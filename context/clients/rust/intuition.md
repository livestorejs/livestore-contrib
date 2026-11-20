# Rust Client — Intuition

_For: contributors to `rust/` · Assumes: the core runtime mental model (leader ⇄
client session) and the sync-cf provider · Covers: why a second-language client
exists and how it stays honest_

Every LiveStore client so far is TypeScript, so "compatible with LiveStore" has
meant "runs the same code". A native client cannot borrow that guarantee. The
Rust client earns it another way: it ports the TypeScript behavior test by test
and checks its outputs against fixtures dumped from the real TypeScript
implementation. The eventlog rows, state rows, DDL, schema hashes, wire frames,
and even the SQLite build must come out identical, because a Rust client and a
browser tab share one store through the same sync backend.

Effect gives the TypeScript code dependency injection, typed errors, scopes and
fibers. The port replaces each with a plain Rust mechanism (trait objects in a
builder, `thiserror` enums named after the TS tags, cancellation tokens, tokio
tasks) so that each TypeScript test reads almost line for line in Rust. That is
the design pressure behind most choices here: keep the shape that makes the
next ported test easy to compare.

Topology is the Node story again. One process, one session, and that session's
leader runs in the same process. There is no multi-tab election, no worker
boundary, no devtools. Of the sync providers, only sync-cf over WebSocket (and
its HTTP fallback) is realized.

The trap: parity is measured against one core commit. The client reads core's
TypeScript snapshots and runs against core's sync worker, so moving the core
pin can break tests that never changed. Treat a pin bump as a parity event
(see LSC.CLIENT.RUST-R05).
