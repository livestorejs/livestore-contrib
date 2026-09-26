# Experiment 0010 - Implemented application tracer bullet

Date: 2026-08-23 (historical snapshot; superseded by the current receipt below)

## Question

Does the contrib-owned implementation compose the accepted runtime, feature,
journal, control, DFX, E2E, and packaging seams without converting local proof
into a live Discord verdict?

## Setup and oracle

The private `apps/discord-bot` workspace pins DFX 1.0.15 and the accepted
Effect beta.105 graph. Its pnpm patch applies the terminal-close repair to the
published DFX package. The oracle requires:

- a frozen install and strict application plus E2E TypeScript check;
- one runtime test crossing Unix RPC, the shared workflow, SQLite, fake Discord,
  docs, readiness, repeat idempotency, and Action Authority exclusion;
- terminal close codes `4004`, `4010`-`4014` to attempt one connection and expose
  a typed failure while transient code `4000` reconnects;
- the complete credential-free automatic/manual/operator/docs matrix with
  fail-closed ownership and cleanup behavior; and
- a Nix flake check, immutable package build, installed CLI smoke, and proof
  that the packaged dependency contains the selected DFX repair.

Live Discord, provider, deployment, and production checks retain separate
verdicts. A provider-only check may prove corpus-to-OpenAI composition without
proving Discord delivery.

## Results

The rows below preserve the original tracer-bullet chronology. They are not
the current aggregate receipt. The current receipt is: DFX patched lock hash
`562aebb5b21f2cb72f2539fa6ea85195d74e905f265a0211b97b9e5dc151f02d`, full
application suite **35 files / 198 tests**, source-executable fake-runtime
black-box **1/1**, the same black-box against the installed executable **1/1**,
credential-free E2E **7/40**, and immutable package build **PASS**.
The harness-model, source-executable fake-runtime, and artifact receipts are
separate evidence classes; none is a live Discord receipt.

| Evidence | Verdict |
| --- | --- |
| `corepack pnpm check` | PASS |
| `corepack pnpm test` | Historical PASS, 23 files and 142 tests in the observed 2026-08-23 checkout; superseded by the current 35-file/198-test receipt above |
| Runtime Unix-RPC/SQLite/fake-Discord/docs/readiness tracer bullet | PASS |
| Bot control operation mapping | Current runtime checks are admitted, including peer authentication and source validation; only `StagingE2ERun` remains gated |
| DFX terminal/transient differential against selected installed package | PASS, six terminal cases and one transient case |
| Harness-model composed E2E | Historical PASS, 11 scenarios with correlated cleanup; current aggregate receipt is 7/40 |
| Source and Nix-installed fake-runtime black-box | PASS, 1/1 against each executable boundary |
| Standalone staging runner | PASS locally: versioned manifest, explicit live confirmation, sanitized PASS/FAIL/UNRUN exit verdicts, and cleanup ownership guards implemented |
| Human-required E2E without a human executor | UNRUN, seven lanes; four automatable negative/guard lanes pass |
| Live canonical `llms-full.txt` corpus retrieval | PASS, digest `sha256:5e2428a5f8b79f2713cfc204077a1bfd6b8198391549c95ca8de71fbf3b986` |
| Dedicated staging OpenAI adapter | PASS: `Answered`, 8 selected sources, 4 citations, 18,567 input tokens, 291 output tokens |
| Provider schema negative control | PASS: initial `uniqueItems` incompatibility failed; removing the unsupported keyword plus a regression assertion made the exact rerun pass |
| Application content retention during provider check | PASS: query, selected excerpts, provider payload, and answer were not persisted; `store:false` does not claim provider ZDR |
| `nix flake check`, package build, installed CLI smoke, packaged DFX repair | PASS |
| Isolated live Discord staging | UNRUN |
| Declared dev4 production deployment and passive verification | UNRUN |

The selected pnpm patch has lock hash
`562aebb5b21f2cb72f2539fa6ea85195d74e905f265a0211b97b9e5dc151f02d`.
The corresponding upstream candidate commit is
`e7f9fe1011128774c51d3148321e82894ffc8981`; its portable source patch has
SHA-256 `cc5d6e25a0ca16b8c3c8a1952b6b2b0dc12030b7dd47bcea6dd1f48f5e402115`.
No upstream PR or release is claimed.

## Conclusion

The accepted tracer bullet is implemented and locally admitted as one
composable application, so “no implementation” is no longer current drift.
It is not a live Discord proof. The standalone live runner is an implemented
operator gate with sanitized verdicts, while `StagingE2ERun` remains the only
deliberately gated runtime control operation. Peer authentication and source
validation are current checks, not open deltas.
The local proof does not establish a Discord identity, effective permissions,
real Gateway/REST mutation, live Discord response, dev4 service ownership,
deployment receipt, rollback, or passive production health. Those lanes remain
open or `UNRUN` in the feature and operations deltas. The dedicated staging
provider path is proved independently of those Discord/deployment lanes.
