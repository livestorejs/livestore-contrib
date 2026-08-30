# 0003 - Reconcile thread creation through a durable per-source ledger

Status: accepted; storage realization amended by the operations
[host decision](../../04-operations/.decisions/0007-use-cloudflare-canonical-host.md)

## Context

Automatic and manual requests can race, Gateway deliveries can repeat, and a
REST timeout can leave creation ambiguous. In-memory timing or a successful
interaction acknowledgement cannot establish a mutation outcome.

## Decision

Persist a per-source creation record in SQLite behind a narrow Effect service.
The initial authority is the environment-local database under dev4's protected
`/var/lib/discord-bot/` state namespace, not LiveStore or telemetry. LiveStore
may later consume a read-only operational projection after the journal contract
is proven.

Records distinguish `pending`, `creating`, `created`, `unknown_external`,
`failed`, and `manual_review`. A transactional per-source claim serializes
automatic and manual races. A timeout after REST submission, or a stale
`creating` record found during crash recovery, becomes `unknown_external`,
never a blind retry: reconciliation first queries Discord for the source
message's deterministic thread identity. A found thread
commits `created`; an outcome that remains ambiguous after the bounded lookup
schedule becomes `manual_review` in the initial release.

SQLite initialization installs `busy_timeout` before WAL negotiation and uses
`synchronous=FULL`. The ordering and durability settings are part of the tested
contract: stress testing exposed `SQLITE_BUSY_RECOVERY` when WAL negotiation ran
first.

Terminal records retain only the Discord identities, state, timestamps, attempt
class, and non-content outcome needed for reconciliation. They expire after 30
days; expiry does not bypass the mandatory Discord existing-thread check.

Accepted 2026-08-23. SQLite availability, crash boundaries, ambiguity
reconciliation, and retention cleanup are production-admission tests.

## Amendment

The authoritative SQLite ledger now lives in the environment singleton Durable
Object. The Effect service and per-source state machine remain unchanged; the
never-activated dev4 filesystem path is superseded. The retained Node adapter
remains source fallback and is not a second authority.
