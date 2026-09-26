# Experiment 0002 — DFX auto-thread prototype

Date: 2026-08-23

## Question

Can bot-owned policy consume typed DFX dispatches and produce one testable
thread action without coupling domain logic to live Discord REST?

## Setup and oracle

A disposable Effect application used DFX 1.0.15 and Effect beta.105, an injected
thread-command port, fake Gateway payloads, and a real DFX layer graph compile.
An eligible `MESSAGE_CREATE` must produce exactly one thread request; bot, DM,
and unmanaged-channel inputs must produce none.

## Results

- TypeScript check: PASS.
- Vitest: PASS, 12/12.
- Demo: PASS; `READY` plus one eligible dispatch produced exactly one fake
  `createThreadFromMessage` request.
- Real `DiscordLive` plus Node HTTP/WebSocket layer graph compiled and loaded.
- No credentials were read and no Discord side effects occurred.

The prototype also showed that a message payload alone does not reliably prove
that its channel is a configured parent rather than a thread. Admission needs a
typed allowlist or validated channel metadata.

## Conclusion

Keep the DFX adapter thin, place eligibility in a pure policy, and inject an
action port. Add durable delivery semantics before this becomes production
code.
