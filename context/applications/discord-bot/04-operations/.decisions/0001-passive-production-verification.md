# 0001 - Verify production passively after deployment

Status: accepted

## Context

The staging E2E can prove the real Gateway and REST mutation boundary. Posting
markers into ordinary production conversations would add avoidable community
side effects.

## Decision

Production verification is passive: compare the exact release and configuration
receipt, verify the declared identity, read external readiness, and verify a
healthy current Gateway session. No ordinary production channel receives a
mutation canary in the initial rollout.

Accepted 2026-08-23.
