# Discord Bot Implementation Plan

Status: accepted for implementation in interview Q147 on 2026-08-23.
This is a delivery map, not a substitute for requirements or acceptance
evidence.

## Work streams

```text
DFX terminal-close upstream ----+
                                v
private app + typed core --> DFX adapters --> staging E2E --> dev4 production
          |                 |                     ^               ^
          +--> CLI/RPC -----+                     |               |
          +--> SQLite journal --------------------+               |
          +--> docs/title provider adapters ------+---------------+
```

## Sequence and gates

| Phase | Owned result | Gate before the next phase |
| --- | --- | --- |
| 0. Track work | One contrib implementation issue/checklist plus linked DFX and dotfiles work | Scope maps to VRS IDs and explicitly preserves live-UNRUN truth |
| 1. DFX upstream | Terminal-close classifier/reconnect repair and deterministic lifecycle tests in `tim-smart/dfx` | Exact build passes fatal/transient close oracle; release or immutable patch identified |
| 2. Private application shell | `apps/discord-bot`, exact admitted dependency graph, schemas, configuration decoder, typed errors, service assembly | Frozen install, strict TS, runtime graph and config negative controls pass |
| 3. Reusable Bot control | Thread/Docs workflows, `@effect/rpc` contract, `livestore-discord` CLI, fake ports | RPC-to-CLI parity, plan zero-write, apply/reason/auth, output and concurrent-call tests pass |
| 4. Feature core | Eligibility policy, title projector/fallback, docs corpus/grounding/rendering, command definitions | Eligibility 579-case oracle, privacy sentinels, grounding/citation and rendering suites pass |
| 5. Durable actions | SQLite schema/service, claim/recovery/retention, migrations and health | WAL/FULL/busy-timeout initialization, crash ambiguity and multi-process stress pass |
| 6. Discord composition | DFX Gateway, REST and interaction adapters wired to shared workflows | Credential-free composed E2E covers automatic, manual, CLI, docs, replay and failure paths |
| 7. Environment infrastructure | Fresh disjoint production and staging Discord apps, dedicated staging guild/actor, one OpenAI project with two service accounts, 1Password refs, dev4 units/sockets | Historical app remains untouched; inventory, intent/permission checks, purpose sentinel, secret projection and scoped readiness pass |
| 8. Live staging | Real auto-thread, filtered zero-action, manual/CLI create, repeat, `/docs`, cleanup, provider and privacy failure exercises | Exact release gets a PASS receipt; absent authority remains UNRUN |
| 9. Production delivery | Dotfiles-owned dev4 production service, singleton transfer, OTLP policy, passive verify and rollback | Exact release/identity/readiness, receipt, passive verification and rebuild-free rollback pass |

## Repository ownership

| Repository | Owns |
| --- | --- |
| `livestore-contrib` | Application, VRS, feature/core/RPC/CLI code, SQLite contract, tests, release artifact and E2E harness |
| `tim-smart/dfx` | Generic Discord lifecycle fix and tests; no LiveStore policy |
| `dotfiles` | dev4 NixOS units/users/sockets/state, deploy-rs, op-proxy secret projection, OTLP and rollback integration |
| Discord/OpenAI/1Password control planes | Environment identities, role/channel/intent settings, dedicated provider project/service accounts and secret values |

## PR shape

Prefer reviewable independent changes rather than one implementation PR:

1. VRS, decisions, and experiment evidence;
2. upstream DFX repair;
3. private app core, control RPC/CLI, and fakes;
4. SQLite and feature workflows;
5. DFX adapters plus credential-free composed E2E;
6. staging configuration/evidence and derived public notice; and
7. dotfiles dev4 delivery followed by live staging and production receipts.

The app can progress against an immutable tested DFX patch while upstream
review runs, but production cannot bypass the terminal-close admission gate.
Live staging and production are verdict-bearing phases; local prototypes cannot
close them.

## Execution status (2026-08-23)

This table is an execution snapshot, not normative intent.

| Phase | Verdict | Evidence or remaining gate |
| --- | --- | --- |
| 0. Track work | PASS | [`livestore-contrib#54`](https://github.com/livestorejs/livestore-contrib/issues/54) tracks the accepted scope |
| 1. DFX upstream | PASS for selected patch; upstream publication open | Exact DFX 1.0.15 package patch and upstream candidate pass six terminal, one transient, and supervisor-failure cases; no upstream PR/release is claimed |
| 2. Private application shell | PASS | Frozen isolated graph, strict TypeScript, runtime/config negative controls, and immutable Nix artifact pass |
| 3. Reusable Bot control | PARTIAL | The CLI/RPC surface and current peer-auth/source checks pass; only `StagingE2ERun` remains `ControlGateUnrun`, and no live Discord receipt exists |
| 4. Feature core | PASS locally and against staging provider | Thread policy/title and docs grounding/rendering suites pass; canonical corpus plus dedicated staging OpenAI adapter returns a validated cited answer with no application content persistence |
| 5. Durable actions | PASS locally | SQLite WAL/FULL/busy-timeout, restart ambiguity, retention, illegal transitions, and six-process cold-start race pass |
| 6. Discord composition | PASS locally; live runner ready | Harness-model receipt is historical; source and Nix-installed fake-runtime black-boxes are each 1/1 and current E2E receipt is 7/40; human-required Discord lanes remain live-UNRUN |
| 7. Environment infrastructure | INCOMPLETE | [Decision 0006](../04-operations/.decisions/0006-use-fresh-discord-applications.md), promoted from Q148 choice A, requires fresh disjoint production/staging Discord applications; their inventory, isolated staging guild/actor/target, and deployed units/sockets do not yet have a complete readiness receipt; historical application `1310646763505582171` is reserved and untouched |
| 8. Live staging | UNRUN | No exact-release live receipt exists; credential-free or human-simulated results cannot substitute |
| 9. Production delivery | UNRUN | No declared dev4 production service, passive verification, deploy receipt, or rollback receipt exists |

The local evidence behind phases 1-6 is consolidated in
[experiment 0010](../.experiments/0010-implemented-tracer-bullet.md).
