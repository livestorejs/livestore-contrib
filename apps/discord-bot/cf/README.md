# cf/ — Cloudflare Workers host for the Discord bot

Single Worker + one SQLite-backed Durable Object (`BotState`), declared
entirely with Alchemy v2 — there is no `wrangler.jsonc`; this stack is the
only IaC source of truth.

## Architecture

```
                 ┌────────────────────────── Worker: DiscordBot ──────────────────────────┐
  HTTPS ────────▶│ fetch ── /readyz            → gateway-aware booleans + release/version │
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

- `src/worker.ts` — entry module: release/secret/version bindings, cron trigger,
  fetch dispatch, and the public-minimal readiness response.
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

## Remote plan and deploy

Run operator commands from `apps/discord-bot`; the generated `package.json` is
derived from `package.json.genie.ts`:

```sh
pnpm check:cf
pnpm cf:preflight
pnpm cf:plan -- --stage staging
pnpm cf:deploy -- --stage staging
```

`alchemy.run.ts` always uses `Cloudflare.state()`. It has no local-state
fallback. `alchemy.local.ts` is the only stack allowed to use
`Alchemy.localState()`.

The remote stack currently admits only explicit `--stage staging`; every other
stage fails before yielding a resource. Production remains separately gated.

### Required remote environment

Provision secrets through op-proxy/Alchemy config; export the non-secret
deployment identity in the invoking environment (not only `--env-file`, because
the Worker resource name is fixed while the module is loaded):

| Binding / variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | gateway + REST identity |
| `OPENAI_API_KEY` | docs answer engine |
| `DOCS_CORRELATION_KEY` | provenance correlation HMAC |
| `E2E_ACTOR_TOKEN` | e2e actor identity |
| `ADMIN_TOKEN` | bearer token for `/admin/rpc/*` |
| `CLOUDFLARE_ACCOUNT_ID` | account queried by the read-only live-identity preflight |
| `CLOUDFLARE_API_TOKEN` | token used by preflight and Alchemy; needs Worker read plus deploy permissions |
| `RELEASE_ID` | required, non-empty immutable source/build identity (max 256 characters) |
| `CF_WORKER_NAME` | expected existing Worker script name; also pins the resource name |
| `CF_BOT_STATE_NAMESPACE_ID` | expected 32-hex `BotState` Durable Object namespace |

`cf:preflight` performs a read-only Cloudflare Worker-settings request and
compares the live script name and `BotState` namespace before Alchemy runs.
`cf:plan` and `cf:deploy` always invoke it first. The stack also compares
resolved outputs, but that check runs after resource reconciliation and is only
a post-apply defense, never the non-mutating adoption precondition. The current
staging identity is:

```sh
export CF_WORKER_NAME=discordbot-discordbot-staging-fzb2yrs5oh7y4ttr
export CF_BOT_STATE_NAMESPACE_ID=9fca2fc956e8417c878f89fac50ea207
```

### One-time staging state migration

Staging was originally deployed from ignored local Alchemy state. Never point
`alchemy.run.ts` at an empty remote stage: that would plan a second
Worker/namespace. Preserve `.alchemy/state/DiscordBot/staging` as the source
receipt.

Alchemy beta.72 has no built-in local-to-remote import CLI, but its public
`StateService` APIs support an exact stack/stage copy. The guarded importer is
landed at `cf/scripts/state-migrate.ts` with these invariants:

- fixed source/destination identity: stack `DiscordBot`, stage `staging`;
- generated migration commands enter `cf/` before loading Alchemy, so
  `localState()` reads `cf/.alchemy/state` rather than the empty app-root path;
- source must contain resources and stack output;
- destination must be wholly absent or already structurally equal;
- differing/partial destination aborts without writes;
- execute rechecks every destination key before writing and never calls delete;
- stack output is copied, then the entire destination is read back and compared;
- logs contain booleans/counts only, never resource records, outputs, or secrets.
- `--verify-equal` is the one-time zero-write cutover gate and rejects absent,
  different, or incomplete remote state after copy;
- `--verify-remote-authoritative` is the steady-state zero-write gate: remote
  resource/output must be complete and retain the canonical Worker/DO IDs, but
  code version and output drift after deploy are accepted.

Remote cutover is blocked until one operator can hold an exclusive-writer
window; Alchemy state has no compare-and-set primitive. Then:

1. Export `RELEASE_ID`, the two expected identities above,
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and remote-state
   credentials. Run `pnpm cf:preflight` and retain its identity receipt.
2. Fence every writer to `.alchemy/state/DiscordBot/staging`; do not run any
   local-state plan/deploy while migration is in flight.
3. Bootstrap the remote state store separately:
   `pnpm exec alchemy cloudflare bootstrap`. Do not deploy the bot.
4. Run `pnpm cf:state:migrate:dry-run`. Continue only when the sanitized JSON
   reports a complete source and an absent destination (copy required), or an
   equal destination (verified no-op). Any partial/different destination is a
   hard abort.
5. Record the writer-fence receipt, then execute exactly once:
   `CF_STATE_MIGRATION_WRITERS_FENCED=1 pnpm cf:state:migrate:execute`.
6. Run `pnpm cf:state:verify-equal`. This is the one-time independent
   zero-write readback; require `destinationEqual`, `noOp`, and `verified`.
7. Run `pnpm cf:state:verify-remote-authoritative`; it must also pass before
   the cutover deploy.
8. Only then run `pnpm cf:deploy -- --stage staging --dry-run`. Require zero
   create, replace, and delete actions before considering a remote-state deploy.

After cutover, remote state/output is authoritative; the frozen local migration
source is not. Every official plan/deploy requires the read-only live identity
preflight and `--verify-remote-authoritative`, so missing/partial state or wrong
canonical Worker/DO IDs cannot reach Alchemy mutation, while normal remote
version/output evolution remains allowed. `--verify-equal` is never a
steady-state deploy gate. The in-stack identity comparison remains only a
post-reconcile final defense.

### Readiness and version/rollback boundary

`GET /readyz` returns HTTP 200 only when all five checks pass:

- `journalCurrent`: journal schema is current;
- `supervisorReady`: supervisor state is `ready`;
- `sessionPresent`: a persisted gateway session exists;
- `gatewayHealthy`: the current activation observed Gateway READY or RESUMED
  and has not recorded a terminal close;
- `errorFree`: no supervision or journal-migration error is recorded.

The JSON body contains only `ready`, `releaseId`, the Cloudflare
`workerVersionId` assigned to the gateway Durable Object, and the `checks`
object with those five booleans. It intentionally omits error text, session
identifiers, config contents, and spend.

The boot fallback is intentionally not matrix-ready: AI-title channels are
empty, the dedicated E2E actor is selected, and its cutover-required purpose
marker cannot match a live channel. Operators must persist the accepted fresh
two-channel config before live-matrix preflight.

Alchemy 2.0.0-beta.72 proves and supplies both the Worker version-metadata
binding (wired here) and `WorkerVersionOptions.traffic`. Percentage traffic is
not a meaningful bot canary: Cloudflare assigns the singleton `gateway` Durable
Object wholly to one version, so the bot workload moves atomically even while
HTTP traffic is split. Candidate proof must therefore use a separate
stage/Discord identity, inspect `/readyz`'s gateway version, then activate
production atomically.

Beta.72 exposes no Alchemy command/resource that selects an already-uploaded
version or rolls a deployment back. A known-good source redeploy creates a new
version; it is a compensating deploy, not rollback proof. Durable Object
migrations additionally require 100% deployment and cannot roll back to a
version from before the migration. Production remains blocked until a
first-class rollback/select-version path is implemented and exercised.

## Local development

- Start the filesystem-state stack with `pnpm cf:dev`. The script sets
  `ALCHEMY_LOCAL=1`; `RELEASE_ID` may be omitted and resolves to `dev`.
- `pnpm check:cf` typechecks the Worker subtree and runs all colocated CF tests,
  including `bundle-check.unit.test.ts`; `pnpm test:cf` runs only those tests.
- Tests run under Bun/Vitest against a hardened node:sqlite fake of the DO
  storage surface (`cf/src/fake-do-storage.ts`) — no Workers runtime needed.
- NixOS gotcha: outbound TLS during installs needs
  `export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.
- `nodejs_compat` stays OFF (declared explicitly in `worker.ts`); the bundle
  must remain node-builtin-free. The bundle check always recrawls the source and
  scans emitted `dist/` JavaScript whenever a build exists.
