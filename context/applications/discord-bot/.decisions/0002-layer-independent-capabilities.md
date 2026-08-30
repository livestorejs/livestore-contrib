# 0002 — Compose independently useful capabilities

Status: accepted

## Context

The bot combines automatic/manual threading and explicit documentation
assistance. Treating one as merely an implementation detail of the other would
make unrelated provider failures suppress useful community behavior. Treating
them only as unrelated products would lose the intended composed support
experience.

## Options

| Option | Consequence |
| --- | --- |
| Conversation structure primary | Threading remains available under AI/docs failure; docs is secondary |
| Independent capabilities | Each feature has its own availability and readiness contract |
| Support assistant primary | Threading may depend on assistant availability |

## Decision

Adopt all three as a layered contract. Threading and `/docs` are independently
useful and fail independently. When both are available, they compose into the
bot's support-assistant experience. Basic eligible thread creation is never
suppressed merely because AI title generation or documentation assistance is
unavailable.

Accepted 2026-08-23 in interview Q138.
