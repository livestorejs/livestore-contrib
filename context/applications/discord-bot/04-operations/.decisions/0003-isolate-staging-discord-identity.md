# 0003 - Isolate staging with its own Discord application and guild

Status: superseded by
[decision 0006](./0006-use-fresh-discord-applications.md)

## Context

The live E2E gate must create and clean up real Discord artifacts without
confusing test authority with the community bot's production authority. A
channel-only separation inside the production guild would still share an
application identity, privileged-intent settings, role configuration, and a
larger accidental-write boundary.

## Decision

Adopt the existing Discord application and installation as production identity;
deployment never recreates them. Create a separate staging Discord application,
bot user, and dedicated staging guild for live E2E and pre-production use.

Production bot, staging bot, and staging E2E Actor credentials are independent
1Password items and runtime projections. Staging has no production guild
membership. Each environment enables exactly the required Gateway intents and
receives only the Discord permissions declared by its enabled features. A
purpose-marked, allowlisted staging channel remains mandatory even inside the
dedicated guild.

Accepted 2026-08-23. Resource IDs, portal settings, permission overwrites, and
`op://` references must be inventoried and verified before any credentialed
run; this decision does not authorize creating or rotating external resources.

Superseded 2026-08-23 after a current Discord API inventory proved that the
historical application now owns Molty/Clawdbot global commands. Reusing it would
cross application ownership boundaries. Decision 0006 retains staging
isolation and extends it to a fresh production application.
