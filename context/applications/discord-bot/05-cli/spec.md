# Discord Bot CLI - Spec

## Status

Draft.

## Architecture

The private `apps/discord-bot` workspace owns one schema-first **Bot control**
contract. Discord handlers, an authenticated administrative RPC server, the CLI,
and tests are adapters around that contract:

```text
MESSAGE_CREATE / interaction --+
                                |
livestore-discord -> admin RPC -+-> BotControl RPC/use cases -> feature core
                                |
recording test client ----------+
```

Implement the contract with Effect schemas and typed tagged errors. Stateful CLI
commands connect to the active runtime's environment-specific Unix-domain
administrative socket on dev4. Socket ownership authenticates the local
operator group; remote use runs the CLI through the fleet's authenticated SSH
boundary. No public administrative HTTP listener is in initial scope.

The RPC server supplies the actor identity. The CLI cannot send an arbitrary
actor field. Each write requires an `OperatorReason` and passes through the same
feature authorization and receipt boundary as a Discord-originated request.

## Command Tree

```text
livestore-discord
  thread inspect <message-ref>
  thread plan <message-ref> [--name <text>] [--no-ai]
  thread create <message-ref> --environment <env> --apply --reason <text> [--name <text>]
  thread status <message-ref>
  thread reconcile <message-ref> [--apply] --reason <text>
  thread reconcile --all --state <ambiguous-state> --limit <n> [--apply] --reason <text>
  policy explain <message-ref>
  docs query <query> [--refresh-corpus]
  docs status
  runtime health [--watch]
  runtime status
  config validate [--file <path>]
  config show
  auth status
  commands diff
  commands sync --environment <env> --apply --reason <text>
  e2e run --environment staging --apply --reason <text> --confirm-live-write
```

All commands accept `--output auto|log|json|ndjson`; `ndjson` is valid only for a
streaming/list result. Staging is the read default; production must be explicit
for writes.
`--reason` is excluded from content telemetry but included in the protected
Control Receipt. Help identifies commands that read Discord content, call an
external provider, or mutate Discord.

`thread create` is the canonical retroactive workflow. It calls the same manual
thread use case as **Create Thread**, with an operator trigger and authorization
decision. It intentionally does not re-run automatic eligibility heuristics:
an operator may create the thread precisely because the old message was skipped.
It still performs source/target validation, existing-thread lookup, naming,
journal claim, ambiguous-effect handling, and receipt emission.

`thread plan` returns a `ThreadPlan`. It performs no AI title request, Discord
mutation, journal write, or command synchronization. It may say which title
source would be selected but cannot claim the title or mutation succeeded.
`thread create` and every other write refuse execution without `--apply` and a
reason; there is no `--force` escape hatch.

## RPC Mapping

| CLI command | Bot control operation | Effect class |
| --- | --- | --- |
| `thread inspect` | `ThreadInspect` | Discord read + journal read |
| `thread plan` | `ThreadPlan` | Discord read + pure evaluation |
| `thread create` | `ThreadCreate` | authorized write |
| `thread status` | `ThreadStatus` | journal read |
| `thread reconcile` | `ThreadReconcile` | Discord read; optional journal transition; never creates |
| `policy explain` | `ThreadPolicyExplain` | Discord read + pure evaluation |
| `docs query` | `DocsQuery` | corpus/provider call; no Discord delivery |
| `docs status` | `DocsStatus` | corpus/model readiness read |
| `runtime health` | `RuntimeHealth` / stream | local read/stream |
| `runtime status` | `RuntimeStatus` | local read |
| `config validate` | `ConfigValidate` | decode/read probes; no mutation |
| `config show` | `EffectiveConfig` | redacted local read |
| `auth status` | `AuthStatus` | effective peer identity/capabilities |
| `commands diff` | `ApplicationCommandsDiff` | Discord read + pure diff |
| `commands sync` | `ApplicationCommandsSync` | authorized Discord write |
| `e2e run` | `StagingE2ERun` | guarded staging writes and cleanup |

## Results and Exit Codes

JSON and NDJSON encode the shared tagged result or error without an extra
CLI-only model. Text output presents blocking problems first, then the outcome,
correlation/receipt, and an actionable next command.

| Exit | Meaning |
| ---: | --- |
| `0` | Success, including `AlreadySatisfied` |
| `1` | Unexpected CLI/runtime defect |
| `2` | Usage, decoding, or invalid target input |
| `3` | Policy or authorization rejection |
| `4` | Runtime/provider/dependency unavailable or transient failure |
| `5` | Terminal application failure |
| `6` | Ambiguous external outcome or manual review required |
| `7` | Live gate UNRUN because required authority/configuration is absent |

## Verification

- Contract tests invoke every Bot control operation through an in-process test
  client and through CLI parsing/rendering fixtures.
- A parity table fails when an administrative RPC method lacks a CLI mapping.
- Golden/schema tests cover text, JSON, and NDJSON output plus exit codes.
- Mutation tests prove plan/diff commands perform zero provider, Discord, and
  journal writes and that write commands cannot override transport-derived
  identity or execute without `--apply` and a reason.
- A staging test invokes `thread create` on an older marker message, observes
  exactly one thread, repeats the command to obtain `AlreadySatisfied`, and
  cleans up through the E2E ownership protocol.

## Current Realization

The private application defines and maps all 16 contract operations. The
tracer-bullet runtime implements 12; `ThreadReconcile`,
`ApplicationCommandsDiff`, `ApplicationCommandsSync`, and `StagingE2ERun`
return the typed `ControlGateUnrun` result. A standalone E2E runner does not
substitute for the `StagingE2ERun` RPC contract. The standalone runner itself is
implemented with a versioned manifest, explicit live-write confirmation,
ownership-safe cleanup, and sanitized PASS/FAIL/UNRUN exit verdicts. Unix-RPC
composition is locally proved for plan/create/repeat/status/docs/readiness,
while authenticated live peer identity and Discord writes remain unproved. See
[DELTA-001](./.delta/DELTA-001-no-bot-control-cli.md).
