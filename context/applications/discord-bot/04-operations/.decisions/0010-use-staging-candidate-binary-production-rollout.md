# 0010 - Use staging as the candidate for binary production rollout

Status: accepted

Evidence: maintainer answer q31 (`staging`), 2026-08-27.

## Context

The bot's Gateway authority lives in one singleton Durable Object per
environment. Splitting ordinary Worker request traffic by percentage does not
create an independent bot actor, exercise a separate Discord application, or
provide bot-canary evidence. A third candidate environment would add an
identity and operational boundary without proving more than the existing
isolated staging application and Durable Object.

A code rollback cannot reverse Durable Object storage or an incompatible API
contract. Treating every prior version as rollback-safe would allow old code to
run against state it cannot interpret.

This decision amends only the rollout mechanism in
[decision 0007](./0007-use-cloudflare-canonical-host.md) and
[decision 0008](./0008-separate-rollout-evidence.md). Their canonical-host and
independent-verdict choices remain accepted.

## Evidence and Argument

Staging already has the independent Discord identity, Worker, singleton Durable
Object, secrets, and state needed to exercise one immutable release through the
functional and operational gates. Production has the same classes of resources
behind a disjoint identity boundary. Promoting the exact artifact after staging
passes proves artifact continuity without inventing a third identity.

The singleton Durable Object owns the persistent Gateway session regardless of
which Worker request reaches it. Percentage traffic therefore measures request
routing, not competing bot behavior. Binary deployment states the actual
authority transition directly. A known-good code redeploy is safe only while
the state and API contracts remain readable by both releases; otherwise a
forward fix is the only state-preserving recovery.

## Options

| Option | Consequence |
| --- | --- |
| A. Staging candidate, then binary production deploy (chosen) | Reuses the isolated candidate boundary, preserves exact artifact identity, and matches singleton Gateway authority |
| B. Percentage production traffic canary | Splits requests but does not create or verify an independent bot actor |
| C. Add a third candidate application and Durable Object | Adds identity, secrets, state, and operations without evidence beyond staging |

## Decision

Choose A. Staging is the only candidate environment. It must earn Functional
PASS and Operational PASS for one immutable release. After both gates pass,
deploy that same release identity and artifact, without rebuilding, as one
binary change to the separate production Worker and singleton Durable Object.
Production keeps its own Discord application, Durable Object storage,
configuration, and secret projection; none is promoted from or shared with
staging.

Do not describe percentage traffic as a bot canary. The production deployment
has one active release for the singleton Gateway actor, and its passive
verification proves exact release, identity, readiness, and current Gateway
health.

Rollback is a binary redeploy of recorded known-good code only while Durable
Object schema and administrative/runtime APIs remain backward compatible. It
does not rewind state, schemas, configuration, or API contracts. If an
incompatible migration is active, keep the Gateway disabled and deploy a
forward fix rather than starting old code against migrated state.

## Consequences

- Alchemy promotes the admitted release artifact from staging to production
  without a rebuild or percentage ramp.
- Environment configuration, Discord application identity, Durable Object
  state, and secrets remain disjoint; only release identity and artifact match.
- Rollback receipts distinguish a compatible known-good redeploy from an
  incompatible migration that requires a disabled Gateway and forward fix.
- No third candidate environment or application is provisioned.
