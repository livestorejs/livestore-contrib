# Experiment 0001 — DFX runtime compatibility

Date: 2026-08-23

## Question

Can current DFX supply the Gateway/REST substrate on LiveStore's supported
JavaScript runtimes, and can an older release avoid changing contrib's Effect
pin?

## Oracle

- The DFX source builds and typechecks on its own declared dependency tuple.
- A protocol-level WebSocket probe exchanges Discord `HELLO` and heartbeat.
- A consumer tuple must satisfy both declared peer constraints and runtime
  evaluation; installation or compilation alone is insufficient.

## Results

| Tuple | Result |
| --- | --- |
| DFX main `23988a4`, Effect/platform beta.105, Node 24.18.1 | build PASS; placeholder upstream test PASS; Gateway probe PASS |
| Same tuple, Bun 1.3.13 | test PASS; Gateway probe PASS |
| `dfx@1.0.14` + contrib Effect beta.98 | consumer TypeScript PASS; Node/Bun runtime FAIL with `Schedule.either is not a function` |
| `dfx@1.0.15` + Effect beta.98 | import/probe PASS but outside declared peer `>= beta.101`; unsupported |
| `dfx@1.0.15`/main + beta.105 | all exercised paths PASS |

The full Gateway graph also bundled and completed the transport probe in local
Cloudflare Worker and Durable Object runtimes. That proves API portability, not
continuous-host suitability: outbound WebSockets cannot hibernate and runtime
shutdown terminates the connection without a shutdown hook.

## Conclusion

Adopt current DFX on an explicitly aligned Effect tuple. Do not use 1.0.14 as a
compatibility shortcut and do not claim the unsupported 1.0.15/beta.98 pair as
safe. A supervised Node/Bun service is the lower-risk initial runtime; hosting
remains an operations interview decision.
