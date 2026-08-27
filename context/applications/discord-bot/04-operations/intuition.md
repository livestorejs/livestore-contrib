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
declared identity + validated config + Cloudflare secret bindings + release
                                  |
                                  v
                       Worker + singleton DO
                                  |
                +-----------------+-----------------+
                |                 |                 |
                v                 v                 v
          readiness state provider diagnostics deployment receipt
                |                                     |
                +------ functional + ops proof -------+
```

The Discord application is the stable identity. A token is only a replaceable
credential for that identity; it must never become configuration, telemetry, or
a deployment artifact. Likewise, message content is transient input, not an
observability payload. Operators need event class, outcome, latency, release,
and a safe correlation value. They do not need a member's words. Provider
diagnostics are content-free and best-effort. Gateway state, readiness, action
journal entries, recovery records, and receipts live in the singleton Durable
Object as operational state rather than telemetry.

Proof has two independent verdicts. The functional verdict comes from the
eleven-lane staging matrix and its zero-artifact oracle. Its two channels use
deterministic titles with AI titles disabled. The operational verdict comes
from authoritative Alchemy remote state, release identity, gateway-aware
readiness, binary deployment and compatible redeploy proof, CI deployment, and
long-duration reconnect observation. A pass in one never implies a pass in the
other, and production stays disabled until both pass for the same release.

Cloudflare is the one deployment topology, and staging is its only candidate
environment. After both verdicts pass, the same immutable release moves in one
binary deployment to the disjoint production application, Worker, singleton
Durable Object, and secrets. Percentage traffic cannot create a second Gateway
actor and is not a bot canary. The Node implementation remains source fallback,
not a parallel service. Reintroducing it as a host would require a new explicit
decision.

The old dev4 proposal remains useful design history, but it was never activated
and is superseded. Cloudflare staging provides a current owned runtime while
the open delta records the still-missing functional and production-operational
evidence rather than treating source or reachability as a complete service
verdict.
