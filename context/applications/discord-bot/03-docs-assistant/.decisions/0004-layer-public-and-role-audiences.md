# 0004 - Layer public and contributor/maintainer docs audiences

Status: accepted

## Context

The predecessor limited `/docs` to one hard-coded administrator. The redesigned
assistant has explicit-query/no-history input, grounded output, typed failures,
and configurable cost controls, making it suitable for broader community use
without granting every channel the same exposure.

## Decision

Allow `/docs` through two configured audience routes:

1. every member with effective `USE_APPLICATION_COMMANDS` permission in an
   explicitly declared public docs-enabled channel or its thread; and
2. members with a configured contributor or maintainer role in explicitly
   declared role-restricted docs-enabled channels or their threads.

Both routes require the native Discord command permission, the same explicit
query, per-member/deployment quotas, provider/retention boundary, grounding,
and failure behavior. Roles extend channel scope; they do not grant ambient
history, a different model, higher-content telemetry, or unbounded spend.

The audience is configured by channel and role snowflakes and validated against
the declared guild. No hard-coded user ID or implicit all-channel fallback is
an authority. Missing/indeterminate membership or channel ancestry fails closed
with an ephemeral response. Direct messages are outside initial scope.

Accepted 2026-08-23 as maintainer choices A plus contributor/maintainer roles.
