# DELTA-001 - No Owned Discord Bot Runtime

Status: open

The operations contract requires a declared Bot Deployment with an owner,
immutable release, validated configuration, secret projection, singleton
runtime, external readiness, deployment receipt, and rollback target
(LSC.APP.DISCORD.OPS-R01 through R06 and R12 through R13). No current running
realization of that contract was found.

Historical source exists in `livestorejs/discord-bot`, but no declarative
service, current runtime host, deployment workflow, external monitor, or durable
receipt identifies a live Gateway consumer. The likely historical host is
retired. The historical Discord application still exists but currently owns
Molty/Clawdbot global commands, so it is explicitly reserved and cannot close
this ownership gap. See
[the investigation reference](../.reference/0001-current-state-investigation.md)
and [decision 0006](../.decisions/0006-use-fresh-discord-applications.md).

Close condition: declare the accepted dev4 deployment and secret projection in
dotfiles, provision and inventory fresh disjoint staging and production
applications plus the isolated staging guild/actor/target, deploy one immutable
release, pass the credential-free and staging-live gates, and capture production
identity, readiness, rollback, telemetry-policy, and receipt evidence satisfying
the referenced requirements.
