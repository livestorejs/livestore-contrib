# Node Adapter — Intuition

_For: contributors to `adapter-node` · Assumes: the core runtime mental model
(leader ⇄ client-session) · Covers: how Node collapses that topology_

The web adapter has to work hard for its topology: SharedWorker to host one
leader across tabs, `navigator.locks` to elect it, OPFS to persist it. Node has
none of those constraints and doesn't pretend to. There is one process, one
session, and that session simply _is_ the leader — no election, no handover, a
lock status that is always `has-lock`. This is why the Node adapter is the
smallest realization of the runtime contract: most of the web adapter's
machinery has no counterpart here.

The one axis of real choice is **where the leader runs**. `makeAdapter` keeps it
in the app's own thread — simplest, best for CLIs, tests, and scripts.
`makeWorkerAdapter` moves it into a `worker_threads` worker so a busy app thread
can't stall materialization or sync. That single choice is what splits the proxy
into two shapes: in-process direct calls versus an RPC boundary with serialized,
transferable payloads. Everything else — filesystem vs in-memory databases, the
boot-status stream, the migrations report, the devtools server — is the same
contract wearing Node's clothes.

The mental trap to avoid: because the session is always the leader, it is easy to
assume Node is "multi-tab-like" and safe to run twice against one `storeId`. It
is not — there is no coordination beyond a shutdown broadcast, so a second
process on the same store fights the first. Node is single-session _today_ — a
current limitation, not a permanent design (the source carries a TODO to add
multi-session support; see [.delta/DELTA-001](./.delta/DELTA-001-no-handover.md)
and LSC.ADAPT.NODE-R03).
