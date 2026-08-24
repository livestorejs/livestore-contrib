# DELTA-001 - Bot control CLI lacks live runtime proof

Status: open

The private application defines all 16 Bot control operations and their CLI
mappings, mutation guards, structured output/exit model, and an
environment-local Unix-domain RPC socket. Peer authentication and source
validation are current checks. The standalone live runner is implemented with
sanitized exit verdicts and the same ownership-safe harness, but is not runtime
RPC parity. Only `StagingE2ERun` deliberately returns `ControlGateUnrun`; it is
the explicit boundary for guarded live staging writes. A source-executable
black-box test proves plan/create/repeat/status/docs/readiness through the
socket, and the harness-model E2E matrix exercises retroactive and concurrent
operator creation. See
[experiment 0010](../../.experiments/0010-implemented-tracer-bullet.md).

No active staging runtime has yet proved the CLI against a live Discord source
message. Production writes remain
unavailable by design until the declared runtime exists.

Close when staging proves a retroactive `thread create`, repeated
`AlreadySatisfied`, receipt, and owned cleanup through the active packaged
runtime. `StagingE2ERun` remains unavailable/`UNRUN` without staging authority;
it must not fall back to direct credentials.
