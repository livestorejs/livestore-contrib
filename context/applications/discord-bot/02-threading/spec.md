# Discord Bot Threading — Spec

Specifies the automatic and manually requested thread-creation pipeline. Builds
on [requirements.md](./requirements.md) and uses
[ontology.md](./ontology.md). Policy-sensitive semantics remain marked by
decision-question IDs; technical defaults are recorded in `.decisions/`.

## Status

Draft.

## Scope

In scope: automatic message intake, the **Create Thread** message action,
trigger-specific policy, thread naming, duplicate/replay reconciliation,
Discord public-thread creation, and structured outcomes.

Out of scope: Discord Gateway lifecycle and command synchronization (parent
runtime), docs answers, moderation, member welcomes, issue creation, and
deployment/alert ownership (parent operations).

## Boundaries

DFX provides typed Gateway dispatch, interactions, and rate-limited Discord
REST. Threading code depends on narrow ports rather than a raw Gateway socket or
HTTP client:

```text
DFX MESSAGE_CREATE adapter ----> ThreadCandidate.fromAutomatic
                                            |
DFX interaction adapter -------> ThreadCandidate.fromManual
                                            |
Bot control operator request --> ThreadCandidate.fromOperator
                                            |
                                            v
                       policy -> naming -> reconciliation
                                            |
                                            v
                                ThreadMutation.create
                                            |
                                            v
                                      ThreadOutcome
```

The adapters validate Discord payloads and preserve Discord snowflakes as
opaque strings. They do not decide channel policy, inspect content to filter a
candidate, choose a title, retry a mutation, or treat an acknowledgement as a
successful thread creation.

## Domain Inputs

Both trigger adapters produce a `ThreadCandidate` containing:

| Field | Automatic | Discord manual | Operator | Purpose |
| --- | --- | --- | --- | --- |
| guild ID | required | required | selected environment | Scope configuration and authorization |
| parent channel ID | required | required | URL/pair then fetched | Locate and constrain the source |
| source message ID | required | required | URL/pair | Correlation and reconciliation key |
| source author ID / bot flag | required | fetched if absent | fetched | Source-validity evidence |
| source content | content boundary | fetched for naming | fetched for naming | Filtering and naming input |
| actor identity | absent | Discord member/roles | RPC peer principal | Authorization evidence |
| delivery correlation | Gateway session/sequence | interaction ID | control request ID | Trace replay without treating delivery as domain identity |

The payload retained beyond processing is governed by the parent data/privacy
contract and decision 0006.

## Evaluation Pipeline

1. Decode and validate the transport payload into a `ThreadCandidate`.
2. For an automatic trigger, evaluate the policy in decision 0005. For a
   Discord manual trigger, require decision 0007's effective target-channel
   permission. For an operator trigger, require the Bot control operator policy.
   Emit a rejected outcome without mutation when the applicable decision
   rejects.
3. Reconcile an existing, in-flight, or completed creation for the source
   message according to decisions 0001, 0003, and 0004.
4. Produce a Discord-valid name under decisions 0002 and 0006.
5. Submit `ThreadMutation.create({ channelId, messageId, name })` through the
   DFX REST adapter.
6. Resolve the trigger to one structured `ThreadOutcome`, recording enough
   identity to correlate it with the source and any created thread.

Automatic, Discord-manual, and operator paths may differ only in step 2 and how
their outcome is presented. Steps 3-6 are shared
(LSC.APP.DISCORD.THREAD-R03, R12).

## Automatic Eligibility Policy

`AutomaticThreadPolicy.evaluate(candidate, config)` is pure and returns either
`Eligible` or `Rejected(reasonCode)`. Evaluation order is stable:

1. configured environment/guild/parent-channel identity;
2. resolved admitted parent-channel kind and not currently inside a thread;
3. ordinary Discord message type, top-level rather than reply;
4. human author, excluding bot, webhook, and application output;
5. no existing thread according to metadata, journal, and Discord lookup; and
6. normalized content-shape classification.

Initial content-shape rejection codes are `empty`, `greeting`, `reaction`,
`recognized_command`, `url_only`, `numeric_or_version_only`, and
`reaction_symbols_only`. Greeting/reaction vocabularies and configured legacy
commands are finite versioned data, not user-configurable regexes. Normalization
may case-fold, trim/collapse Unicode whitespace, and ignore bounded terminal
punctuation; it must not turn a greeting-led sentence into an exact greeting.

`empty` requires no textual body, attachment, or poll. Attachment-only and
poll-only messages are eligible. Attachments or polls prevent URL-only
classification. Lexical prose prevents numeric and reaction-symbol
classification. No length threshold applies.
Reason codes may be counted in bounded metrics; candidate content may not be
included in outcomes or telemetry.

Discord message actions and operator CLI creation are intentional manual
triggers. They may request a thread for a reply or low-information source, but
cannot bypass invalid source/channel kind, automated/system author, existing
thread, authorization, naming, or reconciliation constraints.

## Discord Manual Authorization

The **Create Thread** application command declares no Discord-level default
member permission: a non-null gate would hide the action from unprivileged
members entirely, making the denial UX unreachable. Authorization is instead
enforced at execution: the interaction adapter derives the member's effective
permission in the selected target channel from Discord-authoritative
interaction/resolved permission data, performing a bounded read when the payload
is insufficient. It never trusts a user ID, role list, or permission flag
supplied outside that boundary.

Missing member identity, missing target channel, indeterminate permission, or
absence of `CREATE_PUBLIC_THREADS` yields `AuthorizationRejected` and an
ephemeral response. Passing member authorization does not imply the bot itself
can mutate: readiness separately verifies the bot's least-privilege channel
permissions before the shared workflow attempts REST.

## AI Title Input

`aiTitleChannelIds` is an explicit subset of public managed channels. It cannot
contain a private/moderator channel or staging E2E target. For a source in that
set, the title-input projector:

1. normalizes the source body without adding author or conversation context;
2. replaces Discord user, role, and channel mentions with semantic placeholders;
3. replaces custom emoji identifiers and URLs with `[emoji]` and `[link]`;
4. truncates to 500 Unicode code points; and
5. returns `None` if no meaningful text remains.

The provider input contains only that excerpt and fixed title constraints. It
never contains source/guild/channel/user IDs, usernames, timestamps, history,
attachments, embeds, polls, reactions, reply context, interaction routing, or
operator reason. The Responses request uses `store:false`. Any excluded source,
empty projection, timeout, quota, invalid schema/title, or provider error selects
the deterministic local derivation from decision 0002.

The derived public notice must name OpenAI, explain that bounded public message
text is used only to suggest a thread title, enumerate excluded fields, and
describe the local fallback. Activation tests inject sentinels into every
excluded field and prove absence from provider requests, telemetry, and
receipts.

## Action Journal and Ambiguous Effects

The initial journal is one environment-local SQLite database exposed through an
Effect service; policy and handlers do not issue SQL. A transaction claims the
source-message key before mutation and rejects a stale or concurrent claimant.
Initialization applies `busy_timeout` before enabling WAL and sets
`synchronous=FULL`; changing either requires rerunning the multi-process stress
oracle.
The minimum state progression is:

```text
pending -> creating -> created
                  |
                  +-> unknown_external -> created
                                      `-> manual_review
                  `-> failed
```

The process commits `creating` before submitting DFX REST. A timeout commits
`unknown_external`; recovery treats a stale `creating` record as the same
ambiguous state. Recovery queries Discord for the expected source-anchored
thread identity on a bounded schedule. It may
commit `created` when Discord proves the thread exists, but initial scope does
not automatically repeat the create call when the external outcome remains
unknown. Journal unavailability withdraws mutation readiness rather than
falling back to in-memory action.

The database stores raw source/channel/thread snowflakes because reconciliation
requires them. It stores no message content, generated title, username, prompt,
or docs answer. File access is restricted to the environment's service user;
terminal records are deleted after 30 days. This state is categorically
separate from telemetry and deployment receipts.

## Outcome Model

| Outcome | Meaning | Mutation attempted |
| --- | --- | --- |
| `Created` | Discord confirmed a thread and returned its identity | yes |
| `AlreadySatisfied` | Reconciliation found an existing thread that fulfills the request | no, or an overlapping attempt won |
| `PolicyRejected` | Automatic eligibility rejected the candidate | no |
| `AuthorizationRejected` | Manual authorization rejected the actor | no |
| `TransientFailure` | A dependency may succeed later under the selected bounded recovery policy | maybe |
| `TerminalFailure` | The request cannot safely or validly proceed without changed input/configuration | maybe |

Persistence and retry transitions follow decisions 0001 and 0003. In
particular, this spec does not claim that receiving `MESSAGE_CREATE`,
acknowledging an interaction, or submitting a REST request proves `Created`.

## Verification Contract

Credential-free tests inject the candidate, policy, title generator, clock,
and mutation port and cover at least:

- an accepted automatic candidate reaches exactly the expected mutation call;
- every structural and content reason rejects without naming or mutation, while
  short substantive and mixed-prose counterexamples remain eligible;
- an authorized manual request joins the same creation pipeline;
- an unauthorized manual request reports rejection and never mutates;
- malformed/empty titles never reach Discord;
- duplicate deliveries and concurrent triggers exhibit the at-most-one
  invariant and ledger reconciliation selected by decisions 0001 and 0003;
- crashes before and after REST submission, an ambiguous REST timeout, a found
  deterministic thread, an unresolved ambiguity, journal outage, and 30-day
  cleanup exhibit the action-journal contract;
- generator and REST failures exhibit the degradation/recovery policies selected
  by decision 0002 and the ledger decision 0003.

A staging E2E then uses a dedicated channel and bot identity to observe a real
Gateway message, create a real public thread through DFX REST, correlate the
thread to its source message, exercise **Create Thread**, and clean up its test
artifacts. Production activation remains blocked until that receipt exists and
the parent operations readiness checks pass.

## Current Realization

The private application implements the pure eligibility policy, layered title
degradation, shared automatic/manual/operator workflow, restart-safe SQLite
claim handle, DFX REST mutation port, typed outcomes, and message/interaction
routes. Credential-free tests cover the policy counterexamples, duplicate and
concurrent triggers, ambiguous external outcomes, and composed fake transport.
See [experiment 0010](../.experiments/0010-implemented-tracer-bullet.md).

No live Discord staging receipt or production realization exists. Registration,
Discord-authoritative permissions, real Gateway-to-REST behavior, and owned
cleanup therefore remain open in
[DELTA-001](./.delta/DELTA-001-threading-unrealized.md); the earlier disposable
prototype remains recorded as [prototype evidence](./.reference/dfx-prototype.md).
