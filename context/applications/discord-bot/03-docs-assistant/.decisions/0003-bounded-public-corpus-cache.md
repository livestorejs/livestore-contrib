# 0003 - Use a bounded cache for the public documentation corpus

Status: accepted

## Context

The canonical corpus is public, while each answer needs an immutable snapshot
and digest. Fetching it for every request adds avoidable latency and load.

## Decision

Use a public-corpus cache with a 15-minute default TTL, keyed and evidenced by
the exact snapshot digest. A retrieval or expiry failure reports the corpus as
unavailable; the assistant never uses stale content or general model knowledge
as an ungrounded fallback.

Accepted 2026-08-23. The TTL remains configuration, not a prompt behavior.
