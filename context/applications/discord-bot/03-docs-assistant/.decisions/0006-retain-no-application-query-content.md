# 0006 - Retain no application query or generation content

Status: accepted

## Context

The initial assistant uses an explicit query and no ambient conversation
history. Raw content is unnecessary for action reconciliation, observability,
or corpus caching. Keeping it would add a separate deletion, access, and breach
surface without improving the initial workflow.

## Decision

Do not persist `/docs` queries, title inputs, provider request/response payloads,
generated answers, or source excerpts in application state, caches, logs,
traces, metrics, receipts, or failure records. Keep only content-free Answer
Provenance: corpus digest, model/schema/prompt identity, timing, token/cost
counts, outcome, and a run-scoped correlation.

Per-member rate limiting stores only a keyed one-way member correlation and
bounded counters, expiring within 24 hours. The public documentation corpus may
use its accepted 15-minute cache because it is not user content. The response
delivered to Discord follows Discord's own message lifecycle and is not copied
into bot-owned storage.

Provider-side processing follows decision 0005's disclosed standard retention;
`store:false` prevents intentional Responses application-state storage but is
not described as Zero Data Retention.

Accepted 2026-08-23 as the simplest data-minimizing initial policy.
