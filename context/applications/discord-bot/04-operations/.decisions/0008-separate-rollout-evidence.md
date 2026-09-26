# 0008 - Separate functional and operational rollout evidence

Status: accepted

## Context

The canonical live matrix proves Discord behavior and owned cleanup. Remote IaC
state, release identity, gateway-aware readiness, gradual rollback, CI deploy,
and long-duration reconnect observation prove a different claim: that the host
can be operated safely in production. Requiring one verdict to stand for both
would either discard valid staging behavior evidence or overstate production
readiness.

The accepted staging area contains two purpose-specific channels. AI-generated
titles are optional, outside the canonical matrix, and would require a target
that is not staging-only.

## Decision

Record two independent verdicts for the same immutable release:

1. **Functional PASS** requires the canonical eleven live lanes to pass against
   staging with exact-release receipts and zero remaining owned artifacts.
2. **Operational PASS** requires authoritative remote Alchemy state, externally
   verified release identity, gateway-aware readiness, gradual rollout and
   rollback proof, a CI-owned deployment path, and long-duration reconnect
   observation.

Either verdict may pass while the other remains BLOCKED or UNRUN. Production
stays disabled until both pass; neither verdict can be substituted for the
other.

The canonical `bot-staging` area contains only `#staging-e2e` and
`#staging-docs-restricted`. Both targets are excluded from `aiTitleChannelIds`,
and the matrix uses deterministic local thread titles. AI-title live proof is a
later, separately authorized experiment and channel.

Accepted 2026-08-27 for the confirmed Cloudflare rollout.
