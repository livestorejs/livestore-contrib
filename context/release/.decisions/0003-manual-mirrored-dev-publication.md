# 0003 — Add a manual mirrored dev publication escape hatch

Status: accepted

## Context

Core can publish a SemVer dev cohort before the full stable release pipeline is
ready, but contrib had only SHA-shaped snapshot publication. Consumers testing a
core dev release therefore could not install a matching contrib cohort through
the conventional npm `dev` tag.

## Decision

Add a maintainer-dispatched `publish-dev` mode on the trusted default-branch
workflow. It accepts explicit core and contrib versions, requires them to be the
same `x.y.z-dev.N` SemVer, and requires the live `@livestore/common` npm `dev`
tag to point to that version before contrib publishes.

Publication remains topology-bound and provenance-bearing. Idempotent reruns
must prove packed and registry digests match, verify the mutable `dev` tag,
verify direct core dependency rewrites, and retain a manifest receipt. A tag
mismatch fails closed because the trusted publish operation does not imply
separate out-of-band tag mutation authority.

This is deliberately manual. Core-triggered dispatch and automatic cross-repo
lockstep are deferred rather than implied by this escape hatch.
