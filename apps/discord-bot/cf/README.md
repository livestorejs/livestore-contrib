# cf/ — Cloudflare Workers host for the Discord bot

Single Worker + one SQLite-backed Durable Object (`BotState`), declared
entirely with Alchemy v2 — there is no `wrangler.jsonc`; this stack is the
only IaC source of truth.

## Architecture

```
                 ┌────────────────────────── Worker: DiscordBot ──────────────────────────┐
  HTTPS ────────▶│ fetch ── /readyz            → boolean verdict from BotState.status()   │
  (admin CLI)    │       ── POST /admin/rpc/*  → admin router (bearer auth, ControlResult)│
                 │ scheduled (cron * * * * *) ─► BotState("gateway").tick()               │
                 └────────────────────────────────────┬───────────────────────────────────┘
                                                      │ same-worker binding
                 ┌────────────────────────── Durable Object: BotState ───────────────────┐
                 │ thread_actions journal   → @effect/sql-sqlite-do over DO SQL storage  │
                 │ shard session state      → dfx-compatible keys dfx-shard-state-{i}-{n}│
                 │ docs quota/provenance    → KeyValueStore over DO storage              │
                 │ supervision loop         → Supervisor (forked detached, alarm-gated)  │
                 │ gateway session          → dfx Shard connect per supervised attempt   │
                 └────────────────────────────────────────────────────────────────────────┘
```

- `src/worker.ts` — entry module: secret bindings, cron trigger, fetch dispatch.
- `src/bot-state.ts` — the DO: journal + session state + docs state + supervisor.
- `src/supervisor.ts` — pure reconnect supervisor; `makeShardAcquire` bridges dfx
  Shard lifecycle into SessionEvents. Persistence ownership is single: the
  supervisor checkpoints at READY/RESUMED, dfx's ShardStateStore advances the
  replay sequence over the SAME keys → downstream delivery is at-least-once;
  domain handlers must be idempotent per gateway event.
- `src/admin.ts` — authenticated HTTPS control plane mirroring the socket RPC
  contract (`ControlResult`/`ControlError` bodies). ThreadCreate reports
  `ControlDependencyUnavailable` until the mutation runtime is wired here.
- `src/journal.ts`, `src/docs-state.ts`, `src/storage.ts` — durable state ports.
- `*.unit.test.ts` — colocated suites; run from the app root with
  `pnpm vitest run`.

## Deploy

```sh
cd apps/discord-bot/cf
alchemy deploy --stage staging        # or production
```

Required environment (provision via op-proxy → alchemy env):

| Secret | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | gateway + REST identity |
| `OPENAI_API_KEY` | docs answer engine |
| `DOCS_CORRELATION_KEY` | provenance correlation HMAC |
| `E2E_ACTOR_TOKEN` | e2e actor identity |
| `ADMIN_TOKEN` | bearer token for `/admin/rpc/*` |

Remote state uses `Cloudflare.state()`; for credential-free local experiments
swap in `localState()` in `alchemy.run.ts`.

## Local development

- Typecheck only the worker subtree: `pnpm check:cf` (part of `check`).
- Tests run under Bun/Vitest against a hardened node:sqlite fake of the DO
  storage surface (`cf/src/fake-do-storage.ts`) — no workers runtime needed.
- NixOS gotcha: outbound TLS during installs needs
  `export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.
- `nodejs_compat` stays OFF (declared explicitly in `worker.ts`); the bundle
  must remain node-builtin-free — enforced by `cf/src/bundle-check.unit.test.ts`
  (source recrawl always; post-build `dist/` scan whenever a build exists).
