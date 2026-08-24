# Discord Documentation Assistant — Requirements

Role: the documentation-answering subsystem of the LiveStore Discord
application. It accepts an explicit `/docs` interaction and produces a concise,
source-backed answer from the canonical LiveStore documentation corpus.

## Context

This node is constrained by the parent Discord application's interaction,
runtime, and operational boundaries ([`../`](../)). The predecessor behavior is
recorded as evidence in
[`.reference/old-docs-command.md`](./.reference/old-docs-command.md); that record
does not make its access, context, provider, or prompting choices normative.

## Assumptions

- **LSC.APP.DISCORD.DOCS-A01 Canonical machine-readable corpus:**
  `https://docs.livestore.dev/llms-full.txt` is the canonical aggregate input
  for documentation answers; it may identify more specific published pages as
  sources.
- **LSC.APP.DISCORD.DOCS-A02 Interaction transport:** The parent Discord
  application provides authenticated application-command delivery, deferred
  responses, follow-up responses, and Discord identity metadata.
- **LSC.APP.DISCORD.DOCS-A03 Corpus-bounded scope:** The assistant answers
  questions about the documented LiveStore product. It is not a general-purpose
  community chatbot or a substitute for maintainer judgment.

## Acceptable Tradeoffs

- **LSC.APP.DISCORD.DOCS-T01 Honest incompleteness:** Refusing or qualifying an
  answer is preferable to filling a documentation gap from unverified provider
  knowledge.
- **LSC.APP.DISCORD.DOCS-T02 Grounding latency:** Corpus retrieval, grounding,
  and response validation may make `/docs` slower than an ungrounded generated
  reply, provided the interaction is acknowledged within Discord's deadline.
- **LSC.APP.DISCORD.DOCS-T03 Discord-sized answers:** The assistant may omit
  secondary detail or split a response into bounded follow-ups rather than emit
  an exhaustive answer that exceeds Discord's limits.

## Requirements

### Must expose an intentional documentation request

- **LSC.APP.DISCORD.DOCS-R01 Explicit command:** The assistant exposes `/docs`
  as an application command and never initiates a documentation answer merely
  because an ordinary channel message resembles a question.
  `refines: LSC.APP.DISCORD-R02`
- **LSC.APP.DISCORD.DOCS-R02 Query contract:** A request has an explicit query or
  a context-selection mode authorized by the adopted context policy. Requests
  without sufficient question input receive actionable guidance rather than an
  invented topic.
- **LSC.APP.DISCORD.DOCS-R03 Audience policy:** Command eligibility is governed
  by one explicit, configurable audience policy with a testable allow and deny
  path; authorization is not encoded as a maintainer ID inside command code.
  Decision 0004 defines its layered public and role-restricted routes.

### Must remain grounded in canonical documentation

- **LSC.APP.DISCORD.DOCS-R04 Canonical input:** Every substantive answer is
  grounded in an identifiable snapshot of the canonical documentation corpus
  from A01. A retrieval failure cannot silently fall back to a provider's
  general knowledge.
- **LSC.APP.DISCORD.DOCS-R05 Source-backed output:** A substantive answer
  includes source references that are present in, or mechanically derived from,
  its Documentation Snapshot. An answer whose support cannot be established
  explicitly states that limitation.
- **LSC.APP.DISCORD.DOCS-R06 Provenance:** The subsystem retains enough
  non-secret provenance to identify the corpus snapshot and answer-engine
  configuration used for an answer during diagnosis, without persisting the
  user's conversational content as provenance.

### Must bound conversation and provider exposure

- **LSC.APP.DISCORD.DOCS-R07 Declared context boundary:** Any Discord
  conversation included in a request is selected by a documented context
  policy that bounds channels, messages, fields, and size. The assistant does
  not silently collect unspecified ambient channel history.
- **LSC.APP.DISCORD.DOCS-R08 Data minimization:** The answer engine receives
  only the query, policy-selected context, required corpus material, and
  generation constraints. Discord user IDs, usernames, timestamps, and message
  metadata are excluded unless a separately justified contract requires them.
- **LSC.APP.DISCORD.DOCS-R09 Retention boundary:** Query and context retention is
  explicit and testable across application logs, traces, provider requests,
  caches, and failure records. Initial application retention is zero for query,
  title/generation input, provider payload, answer, and excerpt content;
  content-free rate-limit counters expire within 24 hours. Provider retention is
  disclosed separately and `store:false` is not called ZDR.

### Must produce reliable Discord responses

- **LSC.APP.DISCORD.DOCS-R10 Interaction deadline:** The assistant acknowledges
  each accepted request within Discord's interaction deadline before performing
  work whose duration is not bounded by that deadline.
- **LSC.APP.DISCORD.DOCS-R11 Bounded rendering:** Responses satisfy Discord's
  message limits, preserve code-block integrity, and use a bounded number of
  follow-up messages.
- **LSC.APP.DISCORD.DOCS-R12 Failure clarity:** Authorization denial, insufficient
  input, corpus unavailability, answer-engine failure, invalid output, and
  response-delivery failure remain distinguishable in operator telemetry and
  produce an appropriate non-sensitive user response where delivery is still
  possible. The response never implies a maintainer response or service-level
  commitment, and its failure does not withdraw threading readiness.
  `refines: LSC.APP.DISCORD-R04, LSC.APP.DISCORD-R06`
- **LSC.APP.DISCORD.DOCS-R13 Testable without live services:** Corpus retrieval,
  audience/context policy, grounding validation, rendering, and interaction
  handling are injectable boundaries that can be verified without Discord or
  an external answer provider. A live staging check verifies the composed path.
- **LSC.APP.DISCORD.DOCS-R14 Public disclosure:** The public command description
  and data-use notice are derived from this node's enabled audience, context,
  provider, retention, and failure behavior; they cannot claim disabled modes or
  conceal transferred conversation content. `refines: LSC.APP.DISCORD-R05`

- **LSC.APP.DISCORD.DOCS-R15 Answer-engine source:** Documentation answers use
  the parent OpenAI Responses API model and reasoning configuration. Provider
  output is accepted only after grounding and rendering validation; general
  model knowledge is not a fallback documentation source.
  `refines: LSC.APP.DISCORD-R07`

- **LSC.APP.DISCORD.DOCS-R16 Layered Discord audience:** Every member with
  effective `USE_APPLICATION_COMMANDS` may invoke `/docs` in configured public
  docs channels and their threads. Configured contributor/maintainer roles may
  additionally invoke it in configured role-restricted docs channels and their
  threads. Both routes share quotas and all data/grounding controls; missing
  membership or channel ancestry fails closed, denial is ephemeral, and direct
  messages are excluded.

- **LSC.APP.DISCORD.DOCS-R17 Simple isolated provider project:** AI requests use
  one dedicated Discord-bot OpenAI project with separate staging/production
  service-account credentials, foreground Responses, `store:false`, no provider
  tools/background state, and the accepted exact model/schema. Each environment
  enforces request/token/cost ceilings and fails explicitly at exhaustion; no
  shared-project or alternate-model fallback is allowed.

- **LSC.APP.DISCORD.DOCS-R18 Content-free retained provenance:** Persisted
  Answer Provenance contains only corpus digest, engine configuration identity,
  timing, token/cost counts, outcome, and run correlation. It cannot reconstruct
  the query, generated answer, title input, or source excerpt.

## Resolved technical decisions

- Initial `/docs` requires an explicit query and sends no ambient conversation
  history ([decision 0001](./.decisions/0001-explicit-query-no-ambient-context.md)).
- Answers render a compact mechanically derived `Sources:` footer
  ([decision 0002](./.decisions/0002-compact-source-footer.md)).
- The public corpus uses a bounded 15-minute cache with digest provenance and
  no stale/model-memory fallback ([decision 0003](./.decisions/0003-bounded-public-corpus-cache.md)).
- Public and contributor/maintainer audiences compose through configured
  channel scope ([decision 0004](./.decisions/0004-layer-public-and-role-audiences.md)).
- One dedicated OpenAI project supplies both environments through separate
  credentials ([decision 0005](./.decisions/0005-use-one-dedicated-openai-project.md)).
- Application-owned query/generation content has zero retention
  ([decision 0006](./.decisions/0006-retain-no-application-query-content.md)).
