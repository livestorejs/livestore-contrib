# 0006 - Use fresh isolated Discord applications

Status: accepted; supersedes
[decision 0003](./0003-isolate-staging-discord-identity.md); membership
lifecycle amended by [decision 0009](./0009-retain-e2e-actor-membership.md)

## Context

A current authenticated Discord API inventory found that historical LiveStore
Bot application `1310646763505582171` owns Molty/Clawdbot global commands. Its
continued existence therefore does not make it available for the contrib bot;
reusing or synchronizing commands against it could mutate another application's
operational surface.

## Decision

Create fresh, separately owned Discord applications and bot users for
production and staging. Keep their credentials, declared IDs, command sets,
privileged-intent settings, guild membership, and runtime projections disjoint.
Staging additionally uses a dedicated staging guild and a distinct E2E Actor.

Leave application `1310646763505582171` untouched. It is a reserved historical
identity, not a deployment target, compatibility identity, command-sync target,
or source of reusable credentials. Provisioning must fail closed if either new
environment resolves to that application ID or if staging and production IDs
match.

Accepted 2026-08-23 in maintainer interview Q148, choice A (`fresh-both`), after
reviewing the verified current control-plane evidence. Provisioning and live
verification remain separate authorized actions; this record does not claim
that either fresh application exists.

## Amendment

The historical application, commands, bot user, and credentials remain
untouched throughout. Decision 0009 distinguishes those resources from the
historical bot's staging-guild membership: all three bot memberships remain
through Functional PASS, after which only the historical membership is
uninstalled. The E2E Actor remains installed for recurring regression.
