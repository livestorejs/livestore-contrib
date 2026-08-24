# 0007 - Authorize Create Thread with Discord's native permission

Status: accepted

## Context

The predecessor used hard-coded administrator user IDs. Discord already owns
channel-effective thread permissions through guild roles and channel
overwrites, so a second bot-specific identity or role list would duplicate and
drift from the server's authority.

## Decision

Allow the Discord **Create Thread** message action only when the invoking member
has effective `CREATE_PUBLIC_THREADS` permission in the target channel. Set the
application command's default member permission consistently and recheck the
effective channel permission during execution. If the effective permission
cannot be established, fail closed.

Authorization never comes from a caller-supplied user ID or an application
configuration allowlist. Denial is an ephemeral interaction response. The bot
user's own permission to create the thread is independently checked by
readiness. Operator CLI authorization remains the Bot control/operator policy,
not this Discord member permission.

Accepted 2026-08-23 as maintainer choice A.
