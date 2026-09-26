# Discord Bot Threading — Requirements

Role: organize selected LiveStore Discord channel messages into public threads,
both automatically and through an explicit **Create Thread** message action.

## Context

This is the conversation-organization capability of the contrib-owned Discord
bot. It consumes validated Discord messages and interactions from the parent
runtime and emits Discord thread mutations through a narrow port. DFX is the
selected Discord transport; its Gateway and REST behavior is not duplicated in
this node. The historical bot and disposable DFX experiments are evidence, not
the contract ([`.reference/`](./.reference/)).

## Requirements

- **LSC.APP.DISCORD.THREAD-R01 Automatic trigger:** The bot supports a policy
  under which a newly observed Discord message can request a public thread on
  that source message without a person invoking a command. The accepted channel
  and message classes are the versioned, reason-coded policy in decision 0005,
  not hidden in the transport handler.
  `refines: LSC.APP.DISCORD-R02`
- **LSC.APP.DISCORD.THREAD-R02 Manual trigger:** The bot exposes a Discord
  message action named **Create Thread** through which an authorized actor can
  request a public thread on the selected source message. It reports a clear
  accepted, rejected, already-satisfied, or failed outcome to the invoker.
  Authorization follows decision 0007.
  `refines: LSC.APP.DISCORD-R02`
- **LSC.APP.DISCORD.THREAD-R03 One creation pipeline:** Automatic and manual
  triggers converge on the same source-message validation, title, creation, and
  outcome pipeline after their trigger-specific eligibility or authorization
  decision. A behavior change shared by both paths is implemented once.
  `refines: LSC.APP.DISCORD-R03`
- **LSC.APP.DISCORD.THREAD-R04 Source-message anchoring:** A successful outcome
  creates a Discord public thread anchored to the requested source message and
  does not rewrite or replace that message. The outcome retains the guild,
  channel, source-message, trigger, and created-thread identities needed to
  correlate the action.
- **LSC.APP.DISCORD.THREAD-R05 Replay and race safety:** Before production
  activation, the subsystem defines and verifies how duplicate Gateway
  dispatches, retried interactions, process restarts, and concurrent automatic
  and manual requests for the same source message resolve. The chosen primary
  invariant and recovery mechanism are defined by decisions 0001 and 0003.
- **LSC.APP.DISCORD.THREAD-R06 Valid thread name:** Every creation request sent
  to Discord carries a non-empty thread name valid under Discord's current
  constraints. Naming policy is independent of the Discord mutation port so it
  can be tested deterministically. Generation, content disclosure, and
  degradation behavior are defined by decisions 0002 and 0006.
- **LSC.APP.DISCORD.THREAD-R07 Explicit outcomes:** Every accepted trigger ends
  in a structured outcome: created, already satisfied, policy-rejected,
  authorization-rejected, transiently failed, or terminally failed. Failures
  do not disappear behind a successful Gateway connection or interaction
  acknowledgement; operational visibility and retry policy are owned with the
  parent operations node and refined by decision 0003. AI or
  docs-assistant unavailability does not suppress an otherwise eligible basic
  thread action. `refines: LSC.APP.DISCORD-R04, LSC.APP.DISCORD-R06`
- **LSC.APP.DISCORD.THREAD-R08 Testable decision boundary:** Eligibility,
  authorization, naming, duplicate handling, and the thread mutation port can
  be exercised without Discord credentials. A live staging test separately
  proves the selected policy against a dedicated channel before production
  activation.

- **LSC.APP.DISCORD.THREAD-R09 AI source boundary:** When the naming pipeline
  requests a generated title, it uses the parent generation source and treats
  the response as an untrusted proposal that must pass Discord title validation
  before use. `refines: LSC.APP.DISCORD-R07`

- **LSC.APP.DISCORD.THREAD-R10 Durable action journal:** A local SQLite journal
  behind an Effect service serializes claims and records creation state by
  source message. REST timeout or crash ambiguity becomes
  `unknown_external`; the runtime reconciles Discord's deterministic thread
  identity before any further mutation and otherwise requires manual review.
  Journal outage withdraws mutation readiness. Terminal non-content records
  expire after 30 days without bypassing the existing-thread check.

- **LSC.APP.DISCORD.THREAD-R11 Defensible automatic filters:** Automatic
  creation admits configured parent-channel, ordinary top-level human messages
  and rejects structural non-candidates plus exact normalized low-information
  shapes. It has no universal character threshold, broad prefix regex, or
  emoji-plus-UTF-16-length proxy. The pure policy returns bounded reason codes,
  not content, and is shared by runtime, CLI, fixtures, and tests.

- **LSC.APP.DISCORD.THREAD-R12 Operator trigger:** The Bot control contract
  exposes the same creation use case to an authenticated operator CLI. An
  operator may request a thread for an older message that automatic policy
  skipped, but cannot bypass managed-channel scope, source validity, operator
  authorization, existing-thread reconciliation, naming validation, or the
  durable journal. `refines: LSC.APP.DISCORD-R08`

- **LSC.APP.DISCORD.THREAD-R13 Minimized disclosed title input:** AI naming is
  enabled only in an explicit subset of public managed channels with a
  published processor/data-use notice. The provider receives at most 500
  Unicode code points of redacted source body and no identity metadata, history,
  attachments, embeds, polls, reactions, reply context, or operator reason.
  Excluded/empty/failed cases use the local title; all title content remains out
  of telemetry and ordinary receipts. `refines: LSC.APP.DISCORD-R05,
  LSC.APP.DISCORD-R07`

- **LSC.APP.DISCORD.THREAD-R14 Discord-native manual authorization:** The
  **Create Thread** action requires the invoker's effective
  `CREATE_PUBLIC_THREADS` permission at execution time. The command declares no
  Discord-level default member permission: hiding the action would make denial
  UX unreachable, so unauthorized invocations receive an explicit ephemeral
  denial. Missing/indeterminate permission fails closed. No hard-coded user or
  bot-specific role allowlist is an authorization source.
  **Amendment 2026-08-25:** dropped the command-defaults half of this
  requirement; confirmed by Johannes Schickling (decision-tree Q4) before the
  change. Execution-time enforcement and fail-closed behavior are unchanged
  (decision 0007).

## Resolved technical decisions

- The invariant is at most one bot-created thread per source; Discord remains
  authoritative for ambiguous effects (decision 0001).
- AI naming is a bounded proposal with deterministic local fallback (decision
  0002).
- Creation uses a durable per-source reconciliation ledger (decision 0003).
- Existing threads are idempotent `AlreadySatisfied` outcomes with no mutation
  for archived or locked state (decision 0004).
- Automatic eligibility preserves only defensible predecessor filters through a
  versioned reason-coded policy (decision 0005).
- AI titles use only minimized source text from disclosed public channels
  (decision 0006).
- Discord manual creation follows effective native channel permission (decision
  0007).
