# Discord Bot Operations - Intuition

_For: maintainers and operators of the LiveStore Discord bot - Assumes: the
parent Discord bot contract and Discord's application/gateway model - Covers:
identity, deployment, health, telemetry, and end-to-end proof_

The bot is not merely a set of message handlers. Automatic threading requires
a persistent Discord Gateway session, a credential with privileged intent
approval, and authority to create threads. If nobody can name where that
session runs, which release it runs, and how it proves health, then the feature
has no durable owner even when its source code exists.

Operations therefore treats a running bot as a declared **bot deployment**:

```text
declared identity + validated config + credential projection + immutable release
                                  |
                                  v
                         one runtime instance
                                  |
                +-----------------+-----------------+
                |                 |                 |
                v                 v                 v
          readiness state   content-free traces deployment receipt
                |                                     |
                +---------- live E2E proof ------------+
```

The Discord application is the stable identity. A token is only a replaceable
credential for that identity; it must never become configuration, telemetry, or
a deployment artifact. Likewise, message content is transient input, not an
observability payload. Operators need event class, outcome, latency, release,
and a safe correlation value. They do not need a member's words. Remote traces
are best-effort and expire from Tempo after 30 days; local lifecycle/error logs
stay in the systemd journal under host policy, while deployment receipts remain
durable application state with their own lifecycle.

Proof has layers. Simulation quickly checks policy and failure behavior. A live
staging run crosses Discord's real Gateway and REST boundaries in an isolated
target and cleans up only artifacts it can prove it owns. Production
verification confirms the deployed release, identity, connection, and passive
health without manufacturing a conversation in a community channel.

A rollout has one especially important invariant: at most one production
consumer may act for an environment. Rollback stops the candidate before the
previous release resumes. Brief unavailability is safer than overlapping
instances that can both create threads from the same message.

The old bot lacks this operational envelope. Its historical repository is
useful implementation evidence, but no current owned runtime, declarative
service, deployment receipt, or external readiness proof could be found. That
gap is tracked explicitly rather than treating a source checkout as a service.
