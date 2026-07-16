# S2 Sync Provider — Intuition

*For: contributors to `sync-s2` · Assumes: the core sync mental model
(git-shaped convergence, provider = transport only) · Covers: how an S2 stream
plays the role of the eventlog and why this provider is thinner than it looks*

The core model says a sync provider is *just transport* — `connect/pull/push/
ping` over the schema-defined encoding — and that a single ordering authority
makes convergence trivial. S2 fits that shape almost literally: an S2 stream is
an append-only log with a monotonic physical `seq_num`, so "the eventlog" and
"the S2 stream" are the same object. One store, one stream. Pull is reading the
stream from a position; push is appending to it; the cursor is just "how far
into the stream I've read."

The one twist to keep straight is **two sequence spaces**. S2 numbers records
physically (`s2SeqNum`); LiveStore numbers events logically (`seqNum`, inside the
body). They both start at 0 and today move together, but the code deliberately
brands them apart and refuses to assume 1:1 — because the intended future is
compaction, where the physical stream is rewritten while logical history stays
fixed. So the cursor is carried as opaque `{ s2SeqNum }` metadata: the engine
persists and replays it, the provider alone knows it means "S2 read position."
Treat any code that equates the two numbers as a latent bug.

**Deviation from the Cloudflare/Electric providers.** Cloudflare talks its own
wire protocol straight to a Durable Object that *enforces* fast-forward: a push
that doesn't chain onto the head comes back as `ServerAheadError`, which drives
the leader's rebase. This provider does neither of those. It never talks to S2
directly — it speaks three plain HTTP verbs (GET/POST/HEAD) to an *app-owned API
proxy*, and half the package is helpers for building that proxy's S2 side. And
it does not arbitrate: `push` appends unconditionally (no `match_seq_num` fence)
and any failure — rejection, limit, backend — collapses to `UnknownError`; the
only condition it distinguishes is offline (via `isConnected`). So two clients
that both think they're at head can both append, forking logical history. That
is the crux gap, and it is a **current limitation, not a settled design**: S2
*has* a fencing primitive the provider doesn't use yet
([.delta/DELTA-001](./.delta/DELTA-001-no-fast-forward.md),
[.delta/DELTA-002](./.delta/DELTA-002-untyped-failures.md)).

The mental trap to avoid: because reads and writes "just work" against a live
stream, it is tempting to treat this provider as conformant with the reference.
It is not exercised by the core conformance suite, and until the two deltas
close it should be read as a working transport whose ordering guarantees rest on
clients not racing — not on the backend refusing non-fast-forward pushes.
