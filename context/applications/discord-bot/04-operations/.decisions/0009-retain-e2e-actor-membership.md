# 0009 - Retain the E2E Actor after staging admission

Status: accepted; amends the membership lifecycle in
[decision 0006](./0006-use-fresh-discord-applications.md)

## Context

The canonical matrix needs the staging runtime bot and a separate E2E Actor.
The historical bot is forbidden as a runtime identity but remains installed in
the staging guild. Removing it before the replacement passes would discard a
reversible recovery/history boundary before live proof. Removing the E2E Actor
afterward would make recurring regression runs recreate identity and cleanup
authority.

Guild membership is distinct from the historical Discord application, its bot
user, global commands, and credentials. Uninstalling one guild membership does
not authorize changing or deleting those control-plane resources.

## Decision

Keep all three memberships—the staging runtime bot, historical bot, and E2E
Actor—through the complete eleven-lane functional matrix and zero-artifact
oracle. Matrix setup and execution must not read the historical credential or
modify its application, bot user, commands, or credentials.

Only after Functional PASS may an operator uninstall the historical bot
membership from the staging guild. That membership is the only historical
surface authorized for mutation. Keep the purpose-scoped E2E Actor installed
for recurring regression runs alongside the admitted staging runtime bot.

A failed, blocked, or UNRUN matrix leaves all three memberships unchanged.

Accepted 2026-08-27 for the confirmed staging lifecycle.
