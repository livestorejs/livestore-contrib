# 0003 - Pin the validated DFX dependency graph

Status: accepted

## Context

DFX 1.0.15 requires a newer Effect prerelease than contrib's existing packages,
and DFX 1.0.14 installed against the older line but failed at runtime. A private
application prototype compiled and ran on both Bun and Node only after the
related prerelease packages were aligned exactly.

## Decision

Use the isolated application baseline DFX 1.0.15, Effect 4.0.0-beta.105,
`@effect/platform-node` beta.105, `@effect/platform-node-shared` beta.105, and
`discord-api-types` 0.38.40 with exact lockfile resolution. Do not use DFX
1.0.14 or caret ranges across Effect prereleases.

This tuple is an admitted baseline, not permission to ship the known reconnect
defect. Production also requires decision 0002's upstream release or exact
tested terminal-close patch.

Accepted 2026-08-23 after experiment 0009 passed clean install, strict compile,
and 22/22 tests under both Bun and Node.
