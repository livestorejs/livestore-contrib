# Delta 001 — The contrib-owned Discord application is not live

Status: open

The private `apps/discord-bot` implementation now realizes the local application
composition: shared threading/docs workflows, a durable action journal, typed
Bot control RPC and CLI, DFX adapters, a credential-free E2E harness, and an
immutable Nix package. Its exact local evidence is recorded in
[experiment 0010](../.experiments/0010-implemented-tracer-bullet.md).

No declared staging or production runtime currently realizes that application.
The historical Discord application now owns another command surface and is a
reserved, forbidden deployment target; its existence does not prove a live
Gateway consumer for this application. The old separate repository has no
reconstructable active deployment.

## Consequence

The source-level and credential-free feature contracts have implementation
evidence, but the live contract remains unsatisfied. Documentation must not
claim that the redesigned bot is available, deployed, or live-verified.

## Closure

Close this delta only after an isolated staging identity and target pass the
live automatic, manual, operator, and docs canaries with owned cleanup, and a
declared dev4 production runtime passes exact-release identity, readiness,
passive verification, receipt, and rollback gates. Missing live authority or
configuration remains `UNRUN`, never local `PASS`.
