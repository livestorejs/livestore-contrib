# DFX and E2E Experiment Reference

Captured: 2026-08-23

This is non-normative evidence from disposable, credential-free prototypes.
No Discord API write or secret-store read occurred.

## DFX Gateway prototype

- `dfx@1.0.15` with `effect@4.0.0-beta.105` expressed typed READY and
  MESSAGE_CREATE handlers, a real compile-only DFX layer graph, and an injected
  thread-creation port.
- The simulator passed 12 tests and produced one thread request for one eligible
  message while rejecting bot-authored and direct messages.
- Node.js 24 and Bun 1.3.13 both received Discord's real unauthenticated Gateway
  HELLO, proving the WebSocket/runtime boundary without identifying a bot.
- DFX requires Effect `>=4.0.0-beta.101`; contrib currently pins beta.98. A
  production package must isolate or align that dependency graph.
- Injecting fatal Discord close codes 4004, 4010, 4011, 4012, 4013, and 4014
  into published DFX caused three connection attempts after deterministic clock
  advancement where one terminal attempt is required.

## Live-safe E2E harness

- Five simulator controls passed: out-of-allowlist writes are blocked; a
  correlated message/thread pair is observed and cleaned; an unrelated thread
  is never deleted; timeout still cleans the marker; and cleanup failure fails
  the overall run.
- Running without the explicit live flag failed before token lookup or writes.
- Live Discord execution remains **UNRUN**, not PASS: no isolated actor token and
  no confirmed purpose-marked staging guild/channel were supplied.

These results support the DFX transport choice and the E2E safety protocol, but
do not prove authenticated Identify/Resume, production permissions, real REST
thread creation, rate-limit behavior, or deployment recovery.
