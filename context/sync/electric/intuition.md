# ElectricSQL Sync Provider — Intuition

_For: contributors to `sync-electric` · Assumes: the core sync mental model
(backend as ordering authority, leader ⇄ backend push/pull) · Covers: how
Electric realizes that as a read-replica, and where it stops short_

The Cloudflare provider owns its backend: a Durable Object holds the log,
arbitrates every push against the current head, and answers `ServerAheadError`
so a losing writer knows to rebase and try again. Electric is a different animal.
It is a _read path over Postgres_ — you write events into a Postgres table, and
Electric streams that table's changes to clients as a "shape". The provider is
mostly that read path plus a thin write path, and the whole thing talks to a
consumer-owned proxy rather than to Electric directly (so secrets stay on the
server and the app can layer auth on top).

This reframes ordering. There is no LiveStore-side arbiter; the ordering
authority is the Postgres `seqNum` PRIMARY KEY. Two clients racing to append the
same sequence number can't both win — the DB linearizes them. But this is also
**the key deviation from CF**: the client never receives a rebase signal. A CF
push that loses the race gets `ServerAheadError` and reconverges by rebasing; an
Electric push that fails gets a flat `UnknownError`, which the engine surfaces as
a defect rather than a retry. Convergence-on-conflict, which CF gives you for
free, is not wired here (see [.delta/DELTA-001](./.delta/DELTA-001-no-rebase-signal.md)
and LSC.SYNC.ELECTRIC-R02).

The pull side is Electric's shape protocol wearing the SyncBackend contract:
navigate by Electric's own `{offset, handle}` cursor (not the global seqNum),
long-poll for liveness (Electric closes at ~20 s with a 204; you retry where you
left off), and report `MoreUnknown`/`NoMore` because Electric's immutable caching
won't tell you how many events remain. Two traps live here: because Electric
syncs a _table_, a stray `update`/`delete` can appear — that's someone mutating
the eventlog, and the provider rejects it loudly (`InvalidOperationError`). And
shape handles rotate; when they do, Electric answers 409 and the resync path is
still a `notYetImplemented` TODO, so a live pull can die on rotation
(LSC.SYNC.ELECTRIC-DQ3). Electric is a capable, cache-friendly reader — just not
yet a fully self-healing one.
