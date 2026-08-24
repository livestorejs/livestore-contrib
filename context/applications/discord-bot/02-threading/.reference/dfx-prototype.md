# DFX Threading Prototype Evidence

Status: disposable experiment, not a production realization.

The parent application records the canonical
[experiment](../../.experiments/0002-dfx-auto-thread-prototype.md). On
2026-08-23 that credential-free prototype used `dfx@1.0.15` and
`effect@4.0.0-beta.105` to test the proposed transport seam. It constructed
DFX handlers for `READY` and `MESSAGE_CREATE`, injected a scoped fake
`DiscordGateway`, and replaced Discord REST with a recording `ThreadCreator`
port corresponding to `createThreadFromMessage`.

```text
raw Gateway JSON -> DFX codec -> fake Gateway -> decision -> recording REST port
```

Receipts:

- strict TypeScript check: PASS;
- twelve simulator tests: PASS;
- one eligible message produced exactly one expected thread request;
- bot-authored and direct-message cases did not reach the mutation port;
- acquisition and release of the fake Gateway scope were both observed;
- Node 24 and Bun 1.3.13 each reached Discord's public Gateway `HELLO` in a
  separate no-identify probe.

This falsifies the concern that DFX cannot express an injectable automatic
thread path. It does not settle eligibility, naming, idempotency, recovery, or
authorization and did not use a Discord credential or create a live thread.

Additional integration constraints found by the experiment:

- DFX requires `Guilds`, `GuildMessages`, and privileged `MessageContent`
  intents when automatic filtering/naming reads ambient message content;
- current `dfx@1.0.15` requires Effect `>=4.0.0-beta.101`, newer than contrib's
  then-current `beta.98` pin;
- the published DFX WebSocket layer retried fatal Discord close codes in the
  experiment, so production is blocked on an upstream-first correction or a
  proven containment at the runtime boundary.
