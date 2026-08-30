# DELTA-001 — Documentation Assistant lacks live realization

## Status

Open.

## Intended Contract

The LiveStore Discord application owns a `/docs` assistant satisfying
LSC.APP.DISCORD.DOCS-R01 through R14: canonical-corpus grounding, explicit
audience/context/retention policy, source-backed bounded answers, typed failure
behavior, and testable service boundaries.

## Current Divergence

The private contrib application implements the shared docs workflow, canonical
corpus retrieval and 15-minute cache, strict provider adapter, citation
membership validation, bounded Discord rendering, explicit-query boundary, and
content-free telemetry. Credential-free tests and a live public-corpus retrieval
are recorded in
[experiment 0010](../../.experiments/0010-implemented-tracer-bullet.md).

The dedicated staging OpenAI adapter now proves canonical retrieval, bounded
selection, strict provider output, citation membership, and an `Answered`
result without application content persistence. It does not prove Discord
delivery. No isolated Discord staging run has proved command registration,
deferred responses, Discord rendering, or cleanup. A predecessor
implementation also exists in the separate private `livestorejs/discord-bot`
repository, but its behavior differs from this node in material ways documented in
[`.reference/old-docs-command.md`](../.reference/old-docs-command.md), including
hard-coded authorization, ambient context forwarding, content-bearing telemetry,
and no validated source-reference contract. Its existence therefore does not
close this contract.

## Consequence

Community members still have no deployed and operationally supported path from a
Discord `/docs` request to the new grounded workflow. Provider composition green
does not establish a live Discord response.

## Closure Evidence

Close this delta only when:

1. the remaining non-live contract cases in [spec.md](../spec.md) are green;
2. the production provider credential/model policy is admitted independently;
   and
3. an isolated Discord staging check proves command registration, deferred
   response, canonical retrieval, grounded rendering, typed failure behavior,
   and cleanup without production conversation content.
