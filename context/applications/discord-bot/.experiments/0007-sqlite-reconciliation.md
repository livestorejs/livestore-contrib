# Experiment 0007 - SQLite crash and reconciliation semantics

Date: 2026-08-23

## Question

Can a local SQLite journal serialize automatic, Discord-manual, and CLI races
and recover safely across the non-idempotent REST ambiguity boundary?

## Setup and oracle

`tmp/discord-bot/reconciliation` uses a real Bun SQLite WAL file, a deterministic
fake Discord authority, and three OS processes. Scenarios cover pre-REST crash,
timeout after remote creation, stale `creating`, multiple matches, existing
thread, expiry, concurrent triggers, and database close/reopen.

## Results

`bun tmp/discord-bot/reconciliation/check.ts` passed 8/8 scenarios. An initial
500-run stress pass found `SQLITE_BUSY_RECOVERY` because WAL negotiation occurred
before `busy_timeout`. Moving timeout setup earlier fixed the race. With WAL and
`synchronous=FULL`, a further 100 repeated runs/800 scenarios passed.

Only a pre-REST `claimed` state is safely resumable. Once state is `creating`, an
absent remote lookup cannot prove non-creation and must never trigger a blind
retry. A deterministic match is adopted; bounded unresolved or multiple matches
become `manual_review`.

## Conclusion

The local SQLite design is viable with explicit initialization order and
durability settings. These settings and crash-boundary scenarios are production
admission requirements, not incidental implementation details.
