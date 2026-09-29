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
pnpm cf:plan --stage staging
pnpm cf:deploy --stage staging --yes
```

`cf:deploy` requires explicit approval: pass `--yes` after reviewing the plan,
or set `ALCHEMY_TUI=1` to approve interactively. Without either, it exits 2
before running preflight or Alchemy; it never adds `--yes` automatically.

`alchemy.run.ts` always uses `Cloudflare.state()`. It has no local-state
fallback. `alchemy.local.ts` is the only stack allowed to use
`Alchemy.localState()`.

The existing `cf:plan`/`cf:deploy` scripts remain the staging path. Production
uses the explicit stage-aware `cf/scripts/remote.sh` runner. CI deploys both
stages after the operator-owned initial production creation described below.

### First production deploy (operator-owned; passive verification only)

Prerequisites: staging functional E2E 11/11 and a two-hour soak with a forced
reload at hour one on the **same** `RELEASE_ID`; create the separate production
Discord application in the portal and obtain its snowflake and production bot
token. Bootstrap the shared Cloudflare remote state store first. Export the
production `DISCORD_BOT_TOKEN`, `ADMIN_TOKEN`, `DOCS_CORRELATION_KEY`,
`OPENAI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`DISCORD_APPLICATION_ID`, `RELEASE_ID` (identical to staging), and
`CF_WORKER_NAME=discordbot-discordbot-production` from the approved secret
broker. Leave `CF_BOT_STATE_NAMESPACE_ID` unset. **Do not supply**
`E2E_ACTOR_TOKEN`: it is staging-only. The production token must belong to
`DISCORD_APPLICATION_ID`, not the staging application or historical Molty
application.

From `apps/discord-bot`, with deployment approval, review the complete plan:

```sh
bash cf/scripts/remote.sh plan --stage production --allow-initial-create
AGENT_ACTION_APPROVAL=deploy bash cf/scripts/remote.sh deploy --stage production --allow-initial-create --yes
```

The preflight requires the production Worker to be absent (Cloudflare 404)
and remote `DiscordBot/production` state to be completely empty; the plan gate
requires **exactly** Worker `DiscordBot` and DO `BotState` creation, with only
their new Worker bindings, no updates/replacements/deletions/other resources.
Deploy reruns these read-only guards before mutation. Stop if any gate differs.
After deploy, read back Worker settings and remote state output and pin the
observed 32-hex `BotState` namespace in `cf/src/release.ts`, then export it as
`CF_BOT_STATE_NAMESPACE_ID`; subsequent plans use
`bash cf/scripts/remote.sh plan --stage production` with the pinned identity.
Never rerun `--allow-initial-create` once a production state or Worker exists.

Per OPS 0001, post-deploy production checks are **passive**: compare the
Worker name and `BotState` namespace against the recorded canonical identity,
check the deployed `releaseId` matches `RELEASE_ID`, and GET `/readyz` without
posting test messages, registering E2E actors, or changing config. Require HTTP
200, `ready: true`, all five gateway checks true, and a present gateway
`workerVersionId`. If unhealthy, stop and diagnose/rollback; do not stimulate
production with active E2E traffic.

For production rollback after pinning, export `CF_DEPLOY_STAGE=production`,
`CF_WORKER_NAME`, and `CF_BOT_STATE_NAMESPACE_ID` before `cf:rollback list` or
an approved `select`; the same read-only identity guard applies first.

### Required remote environment

Local operators can provision secrets through op-proxy/Alchemy config.
The manual `deploy-discord-bot.yml` workflow injects five Worker secrets for
staging and four for production from the corresponding GitHub environment.
Production binds `OPENAI_API_KEY` for AI titles; `/docs` remains off until
the separate broker re-proof. `Config.redacted` binds provided secrets as
Cloudflare `secret_text`, not pre-existing Secrets Store references. Export
deployment identity in the invoking environment (not only `--env-file`, since
the Worker name is fixed while the module loads):

| Binding / variable          | Purpose                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `DISCORD_BOT_TOKEN`         | gateway + REST identity                                                        |
| `OPENAI_API_KEY`            | staging docs and production AI titles                                          |
| `DOCS_CORRELATION_KEY`      | provenance correlation HMAC                                                    |
| `E2E_ACTOR_TOKEN`           | staging-only e2e actor identity                                                |
| `ADMIN_TOKEN`               | bearer token for `/admin/rpc/*`                                                |
| `CLOUDFLARE_ACCOUNT_ID`     | account queried by the read-only live-identity preflight                       |
| `CLOUDFLARE_API_TOKEN`      | token used by preflight and Alchemy; needs Worker read plus deploy permissions |
| `RELEASE_ID`                | required, non-empty immutable source/build identity (max 256 characters)       |
| `CF_WORKER_NAME`            | expected existing Worker script name; also pins the resource name              |
| `CF_BOT_STATE_NAMESPACE_ID` | expected 32-hex `BotState` Durable Object namespace                            |
| `DISCORD_APPLICATION_ID`    | production app snowflake (required by production Worker binding)               |

Set these GitHub **environment secrets** for each stage. The workflow also
reads `CACHIX_AUTH_TOKEN` from shared secrets when configured:

| Environment  | Secret names                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `staging`    | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DISCORD_BOT_TOKEN`, `DOCS_CORRELATION_KEY`, `ADMIN_TOKEN`, `E2E_ACTOR_TOKEN`, `OPENAI_API_KEY` |
| `production` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DISCORD_BOT_TOKEN`, `DOCS_CORRELATION_KEY`, `ADMIN_TOKEN`, `OPENAI_API_KEY`                    |

Set these non-secret GitHub **environment variables**:

| Environment  | Variable                    | Value                                                                          |
| ------------ | --------------------------- | ------------------------------------------------------------------------------ |
| `staging`    | `CF_WORKER_NAME`            | `discordbot-discordbot-staging-fzb2yrs5oh7y4ttr`                               |
| `staging`    | `CF_BOT_STATE_NAMESPACE_ID` | `9fca2fc956e8417c878f89fac50ea207`                                             |
| `staging`    | `CF_WORKER_URL`             | `https://discordbot-discordbot-staging-fzb2yrs5oh7y4ttr.livestore.workers.dev` |
| `production` | `CF_WORKER_NAME`            | `discordbot-discordbot-production`                                             |
| `production` | `CF_BOT_STATE_NAMESPACE_ID` | `02c1287918754225ae1ff48bfeae4d60`                                             |
| `production` | `CF_WORKER_URL`             | `https://discordbot-discordbot-production.livestore.workers.dev`               |
| `production` | `DISCORD_APPLICATION_ID`    | `1553674978757451776`                                                          |

The job derives `RELEASE_ID` from `github.sha`, sets `CF_DEPLOY_STAGE=production`
on production plan and deploy steps and `AGENT_ACTION_APPROVAL=deploy` on the
deploy step, and never passes `E2E_ACTOR_TOKEN` to production. The
account-scoped API token needs Workers Scripts Write, Account Settings Read,
and Secrets Store Read/Write:
Alchemy's remote state store recovers its bearer from Cloudflare Secrets Store
on a fresh runner. The state store must already be bootstrapped and each
stage's remote state must pass `--verify-remote-authoritative`; CI cannot
migrate missing state or create the initial production Worker. Deployments are
serialized by stage and never cancel a running deploy. Production dispatch is
restricted to `main` and waits for the GitHub `production` environment's
required reviewer approval. Dispatch staging on an approved ref with
`gh workflow run deploy-discord-bot.yml --ref <approved-ref> -f stage=staging`,
or production from `main` with
`gh workflow run deploy-discord-bot.yml --ref main -f stage=production`.
Inspect the gated plan and require the final `/readyz` check to report HTTP
200, all five checks true, and `releaseId` equal to the dispatched SHA.

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
8. Only then run `pnpm cf:plan --stage staging`. Require the top-level Worker
   and `BotState` Durable Object namespace to be update/noop, with zero replace
   and delete actions. Worker binding-child creates (such as
   `CF_VERSION_METADATA` or `RELEASE_ID`) are allowed: preflight and
   `--verify-remote-authoritative` already prove canonical Worker/DO identity.

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

A successful `PUT /admin/config` with `reload: true` validates a throwaway
candidate, persists the revision, interrupts the previous Gateway owner, drops
the installed runtime, and schedules an immediate Durable Object alarm. The
RPC-built candidate is never installed: its scoped services belong to the
finished admin invocation. Until the alarm builds the replacement,
`GET /admin/config` reports the stored revision with no running revision.

The alarm takes the cold-boot path (`ensureRuntime` → gate claim → supervisor),
builds the runtime in its own invocation, and waits outside the lifecycle mutex
until its first READY/RESUMED checkpoint or the 30-second handshake window.
Detached gateway fibers use an instance-owned microtask dispatcher so queued
work does not depend on a stale `setTimeout(0)` flush. The BotState gate also
has a 35-second owner deadline: if startup stalls even before the supervisor's
first attempt, the next alarm interrupts that owner, drops the runtime and
rebuilds from stored config on another alarm. The persisted session is kept
for RESUME; only the supervisor's own handshake timeout clears it for IDENTIFY.
Readiness stays false until the new Gateway session reports READY or RESUMED.

If a cold build fails before installing a runtime (including a transient REST
failure), the 20-second build deadline ends that attempt and the alarm
reschedules itself with 5-second exponential backoff capped at 60 seconds.
The failed identity request records only its error class/reason, transport
cause name, HTTP status, content type, body length, and elapsed time, never
response content or credentials. Cron never starts an owner; each minute it
repairs a missing alarm and logs both the deadline and current time.

While the runtime awaits its alarm build, authenticated status reports when
that state began and the last sanitized build failure, if any; it does not
misclassify the pending state as a Discord REST error.

Routine alarm reconciliation leaves an in-flight `creating` thread claim
untouched until its reconciliation deadline; otherwise an alarm can adopt the
new Discord thread before its claimant records `markCreated`, turning a
successful create into an ambiguous journal conflict. Explicit reconciliation
and cold-start recovery still inspect it immediately. The authenticated
`RuntimeStatus` response exposes a bounded in-memory diagnostic window (last
20 automatic stages and total `MESSAGE_CREATE` frames), including `received`,
`eligible`, `rejected`, `claimed`, `rest-create-start`, `created`, and `failed`.
Reasons are allowlisted, and source correlation uses the docs HMAC key
(`DOCS_CORRELATION_KEY`, or a per-instance fallback) truncated to 16 hex
characters; no raw source IDs or message content enter the window or logs.

The gateway supervisor bounds each connection's wait for READY/RESUMED to 30
seconds. If a RESUME stalls, it clears the persisted session before retrying
with IDENTIFY; a stalled IDENTIFY retries with backoff. The timeout withdraws
readiness, records a content-free `handshake-timeout` gateway observation, and
sets `errorFree: false` until a successful READY/RESUMED. Gateway telemetry
also distinguishes `socket-close:<code>` from `socket-transport-error` when
DFX's lifecycle does not provide a close code. The precise Effect Socket
Open/Close/Read/Write error class is unavailable from DFX's current lifecycle;
exposing it requires a DFX lifecycle change, ideally upstreamed alongside the
existing terminal-close patch.

The live DFX codec also counts inbound Gateway opcodes and only allowlisted
dispatch names (`READY`, `RESUMED`, `GUILD_CREATE`, `MESSAGE_CREATE`,
`INTERACTION_CREATE`, other), outgoing heartbeat encodings, inbound ACKs, and
the last ten socket close codes in `RuntimeStatus.automaticDiagnostics.gatewayFrames`.
Frame counters and the window are instance-memory observations, not durable soak
evidence; the latest codec-observed ACK timestamp is also folded into durable
Gateway telemetry on the next alarm. Outgoing encoding alone does not prove
Discord acknowledged the heartbeat. `/readyz` allows at most two heartbeat
intervals from the current socket's HELLO while waiting for the first ACK,
then requires a fresh ACK within two intervals.
The Durable Object alarm runs at most half a heartbeat interval apart while
connected and sends an overdue heartbeat from an active alarm invocation if
DFX's timer-bound heartbeat has not fired.

An invalidated RESUME may trigger DFX's internal close-code-3000 reconnect
before a fresh READY. That READY starts a new session and can reset its
sequence number: the supervisor applies its monotonic guard only to checkpoints
from the same session ID and does not publish readiness for rejected events.

DFX's `ShardLive` currently installs its own `MesssagingLive` hub internally,
even if a caller provides `Messaging`. That silently isolates Gateway dispatches
from the caller's dispatch pump. This Worker instead constructs `Shard` from
DFX's `make` with the pump's exact `Messaging` service and checks hub identity
at construction. Upstream follow-up: expose a composable Shard layer that
accepts a shared Messaging service without installing a private hub.

DFX's DiscordREST currently annotates 429 debug logs with raw `request.url`;
webhook and interaction callback paths include credential tokens. Upstream
follow-up: replace that annotation with a route template in DFX. Until then,
the shared Discord logger redacts URL token segments and authorization values
before output, and runtime/Worker/E2E scopes enforce Info minimum logging.

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

Alchemy beta.72 cannot select an already-uploaded Worker version, so
`cf:rollback` selects one through Cloudflare's
[Versions list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/),
[version detail](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/),
[Deployments list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/),
and [Create Deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)
APIs. Use an account-scoped token with **Workers Scripts Write** permission
(Cloudflare's deployment-create API names this permission explicitly).
The scoped ephemeral token minted by
`tmp/discord-bot/mint-ephemeral-cf-token.sh` includes account-level
`Workers Scripts Write` (permission group `e086da7e2179491d91ee5f35b3ca210a`).
Export `CF_WORKER_NAME`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`
as above; `list` is read-only and prints deployable version IDs, creation
metadata, `RELEASE_ID` when exposed in the version's plain-text binding, and
the platform migration tag. Before selection, independently establish that
the recorded known-good version and the current code read the same DO state
and API contracts:

```sh
pnpm cf:rollback list
AGENT_ACTION_APPROVAL=deploy pnpm cf:rollback select --version <known-good-UUID> --yes --assert-do-compatible
```

Selection creates a new 100% deployment of existing code, without rebuilding
or reverting DO storage/configuration. It requires `--yes` and the deploy
approval, refuses a split current deployment, unknown/nondeployable version,
and different Cloudflare DO migration tags. Alchemy derives the `BotState`
class migration from the same-worker binding in `src/worker.ts`, rather than
declaring a hand-maintained migration list. Cloudflare version detail exposes
`script_runtime.migration_tag`, but neither it nor the deployment API proves
that application SQL journal migrations or admin/runtime APIs are backward
compatible. Thus `--assert-do-compatible` is mandatory even if tags match or
are absent. After the sanitized selection receipt, independently require
`/readyz` HTTP 200 with all checks true, `releaseId` matching the target,
and `workerVersionId` matching the selected UUID (this field is the gateway
Durable Object's version, not merely the HTTP Worker). A receipt marked
`readiness: UNVERIFIED` is not rollback PASS until that check succeeds. If an
incompatible state/API migration has occurred, keep the Gateway disabled and
deploy a forward fix, never select older code.

The POST is not retried. If its response fails or is lost after dispatch,
`cf:rollback` re-reads the latest deployment: `outcome: applied` (exit 0)
means it now serves the selected version at 100%; `outcome: unknown` (exit 3)
means the readback is unavailable or does not yet show that selection.
**Do not blindly rerun an unknown selection:** inspect the Deployments list
and `/readyz` first. Before POST, failures report `outcome=not-applied`
(exit 1) with a sanitized step, HTTP status when known, or named guard.

Staging rollback proof (operator-owned; never perform an unapproved live
selection): record N−1 as known-good via `pnpm cf:rollback list` and `/readyz`;
deploy N through `pnpm cf:plan --stage staging` then
`AGENT_ACTION_APPROVAL=deploy pnpm cf:deploy --stage staging --yes`; require
`/readyz` 200 with `releaseId=N` and gateway `workerVersionId=N`.
After checking schema/API compatibility, select N−1 with the command above
and require `/readyz` 200 with all checks true, `releaseId=N−1` and
`workerVersionId=<N−1 UUID>`; then select N with the same approval/assertion
flags and require `/readyz` 200 with `releaseId=N` and
`workerVersionId=<N UUID>`. Compare the IDs with the latest 100% deployment
from the Deployments list API. Any 503, release/version mismatch, or failed
gateway check is a failed redeploy proof, not a PASS.

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
