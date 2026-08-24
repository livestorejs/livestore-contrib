# 0002 - Admit only terminal-close-safe DFX

Status: accepted

## Context

Current DFX behavior retries Discord close codes that represent terminal
configuration, authentication, version, shard, or intent failures. A wrapper
around the socket layer cannot reliably prevent that internal retry loop.

## Decision

Production admission requires either an upstream DFX release or an exact
pinned patch whose tests classify close codes `4004`, `4010`, `4011`, `4012`,
`4013`, and `4014` as terminal before retry scheduling. A per-runtime retry
wrapper is not an accepted repair.

Accepted 2026-08-23. The selected artifact must prove this behavior in the
dependency-admission suite.
