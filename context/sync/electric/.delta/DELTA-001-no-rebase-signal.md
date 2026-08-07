# DELTA-001 — No rebase-triggering push rejection on Electric

Status: open

The core sync contract makes push rejection a typed, recoverable condition:
concurrent-writer conflicts surface as `ServerAheadError`, which yields to the
pull-driven rebase so the losing writer reconverges rather than failing (core
LS.SYS.SYNC-R01, LS.SYS.SYNC-R03; the "wait/reconnect · rebase and retry"
recovery rule in the core error taxonomy). The reference realization (CF) does
exactly this inside `blockConcurrencyWhile`.

The Electric provider does not realize this. The client's `push` POSTs the batch
and only inspects `{ success }` (`src/index.ts:366`–`:379`); any failure is
mapped to `UnknownError` (`:374`, `:377`) — the core **defect** family, which is
surfaced and not retried. There is no `ServerAheadError` and no client-side
head-chain check.

What _is_ satisfied: total order (core LS.SYS.SYNC-R01) holds at the storage
layer, because `seqNum` is the Postgres PRIMARY KEY
(`src/make-electric-url.ts:123`), so concurrent appends of the same sequence
number cannot both commit. The gap is not "no ordering authority" — it is "no
rebase-triggering rejection signal reaching the client," so a losing writer
errors out instead of reconverging.

The actual server-side conflict handling (what the proxy/DB returns on a PK
collision, and whether it could be shaped into a `ServerAheadError`) lives in the
consumer's proxy and is out of this package (referenced example:
`examples/web-todomvc-sync-electric/src/server/db.ts`); this delta records only
the client-observable contract.

Close condition: either the provider maps a Postgres/proxy write conflict to a
rebase-triggering rejection (a `ServerAheadError` equivalent) so the engine
rebases and reconverges, or the core taxonomy is refined to admit
defect-on-conflict for append-only-DB providers and LSC.SYNC.ELECTRIC-R02 is
restated as a conformant realization of that refined contract.
