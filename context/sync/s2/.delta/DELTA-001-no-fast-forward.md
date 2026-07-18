# DELTA-001 — Fast-forward arbitration not enforced

Status: open

The core provider contract makes the backend the single ordering authority: it
"accepts a push only when the batch chains onto its current head" and thereby
linearizes concurrent writers (core LS.SYS.SYNC-R01). The S2 stream satisfies
the *authority* half of that — it is one append-only log that assigns physical
`seq_num` and does not renumber clients' logical `seqNum`. But the *fast-forward*
half — reject a push that does not chain onto the head, so a behind client is
told to rebase — is not realized.

Grounded, in-package evidence (the API proxy that fronts S2 is out of scope, so
this delta is anchored on client-side facts, not on S2 behavior):

- `push` sends `{ storeId, batch }` only and expects `{ success }`; any non-2xx
  becomes `UnknownError` (`src/sync-provider.ts:262-302`, `:264-288`). There is
  no `ServerAheadError`, so even if a proxy rejected a non-fast-forward push, it
  could not surface as the typed condition that drives the leader's rebase loop.
- The shipped S2-facing helper appends records with **no** `match_seq_num` fence
  (`src/s2-proxy-helpers.ts:159-178`), so the reference proxy performs an
  unconditional append.

Consequence: two clients that each believe they are at the head can both append,
producing two S2 records carrying the same logical `seqNum` — a fork in logical
history that the core model forbids by construction.

This is a **current limitation, not a settled design**. S2 exposes a conditional
append primitive (`match_seq_num`, `src/http-client-generated.ts:603`) that
could be the arbitration mechanism today: while the physical/logical mapping is
1:1, fencing on the physical tail fences the logical head. The complication is
the intended future — the source pins the two sequence spaces apart precisely to
allow compaction (`src/sync-provider.ts:17-19`), under which physical position
no longer tracks the logical head, so a naive `match_seq_num` fence would not
express the intended invariant.

Close condition: either the provider (or its proxy contract) enforces
fast-forward — a fencing primitive plus a `ServerAheadError` surfaced back
through `push` (which also closes part of
[DELTA-002](./DELTA-002-untyped-failures.md)) — and the interaction with
compaction is captured (LSC.SYNC.S2-DQ3); or the core contract is refined to
admit provider realizations whose ordering rests on non-racing clients, and
LSC.SYNC.S2-R02 is restated as a conformant realization of that weaker contract.
