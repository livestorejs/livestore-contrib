# Discord Documentation Assistant — Spec

This document specifies the documentation-answering subsystem of the LiveStore
Discord application. It builds on [requirements.md](./requirements.md) and uses
the language defined in [ontology.md](./ontology.md).

## Status

Draft.

**Maturity: experimental**

Initial context, citation, freshness, audience, provider, and retention policy
are selected in decisions 0001-0006.

## Scope

This node defines `/docs` request handling, canonical-corpus acquisition,
answer grounding, Discord rendering, and the privacy boundary between them. The
parent application owns Gateway/REST connectivity, command synchronization,
global configuration, secret delivery, process lifecycle, and deployment.
Automatic thread creation is a sibling subsystem and does not trigger this one.

## Component Boundary

```text
Discord interaction transport (parent)
       |
       v
DocsCommand -----> AudiencePolicy
       |
       +---------> ContextPolicy
       |
       +---------> DocumentationCorpus
       |                  |
       |                  v
       +----------> DocumentationSnapshot
                          |
                          v
                     AnswerEngine
                          |
                          v
                    AnswerValidator
                          |
                          v
                    DiscordRenderer
                          |
                          v
Discord response transport (parent)
```

Each arrow crossing from command orchestration into policy, corpus, engine,
validation, or rendering is an injectable Effect service boundary
(LSC.APP.DISCORD.DOCS-R13). The application composes concrete layers; tests use
in-memory implementations.

## Request Flow

For every `/docs` interaction (R01, R10, R12):

1. Decode the interaction into routing metadata and an explicit query/context
   selection without placing raw content in logs or span attributes.
2. Ask `AudiencePolicy` for an allow/deny result. A denial is acknowledged and
   receives a non-sensitive denial response.
3. Acknowledge an allowed interaction before Discord's deadline.
4. Ask `ContextPolicy` to produce either no Query Context or a bounded,
   disclosure-compatible selection. No handler may fetch messages around this
   boundary independently (R07–R09).
5. Reject insufficient question input with usage guidance (R02).
6. Acquire a Documentation Snapshot from the canonical corpus (R04).
7. Ask `AnswerEngine` for a structured candidate using only the minimized input
   described in R08.
8. Validate the candidate's bounds and Source References against the snapshot.
   Unsupported references or structurally invalid output fail closed (R05).
9. Render one initial response and a bounded set of follow-ups, preserving code
   blocks and source links (R11).
10. Record outcome class and Answer Provenance, excluding raw user content
    (R06, R09, R12).

## Service Contracts

The signatures below describe semantic boundaries rather than a committed
module layout. Concrete schemas use Effect Schema and reject unknown variants.

```ts
type DocsRequest = {
  readonly interaction: InteractionRoute
  readonly query?: string
  readonly contextSelection?: ContextSelection
}

type DocumentationSnapshot = {
  readonly digest: string
  readonly retrievedAt: string
  readonly content: string
  readonly sources: ReadonlyArray<SourceReference>
}

type GroundedAnswer = {
  readonly messages: readonly [string, ...ReadonlyArray<string>]
  readonly sources: readonly [SourceReference, ...ReadonlyArray<SourceReference>]
  readonly uncertainty?: string
}

interface AudiencePolicy {
  readonly authorize: (request: DocsRequest) => Effect<AudienceDecision>
}

interface ContextPolicy {
  readonly select: (request: DocsRequest) => Effect<Option<QueryContext>>
}

interface DocumentationCorpus {
  readonly snapshot: Effect<DocumentationSnapshot, CorpusUnavailable>
}

interface AnswerEngine {
  readonly answer: (input: AnswerInput) =>
    Effect<GroundedAnswer, AnswerEngineFailure | InvalidAnswer>
}
```

`InteractionRoute` contains only identifiers and tokens required to edit the
deferred response; it is never passed to `AnswerEngine`. Initial
`ContextSelection` is the explicit query only, with no ambient Discord history
([decision 0001](./.decisions/0001-explicit-query-no-ambient-context.md)). The
`AudienceDecision` follows decision 0004. Provider realization and retention
follow decisions 0005 and 0006.

## Audience Policy

`AudiencePolicy` first requires the interaction guild and effective
`USE_APPLICATION_COMMANDS` permission. It resolves a thread to its parent before
matching one of two configured routes:

| Route | Channel scope | Additional actor condition |
| --- | --- | --- |
| `public` | `publicDocsChannelIds` or their threads | none |
| `roleRestricted` | `roleDocsChannelIds` or their threads | at least one `docsRoleIds` role |

All IDs must belong to the declared environment guild. Missing guild/member,
unknown channel ancestry, missing native permission, or no matching route is a
typed denial with an ephemeral response. Direct messages are rejected. Role
membership changes scope only; it cannot select ambient context, different
provider/retention behavior, or higher quotas unless a later explicit contract
introduces that distinction.

## Grounding and Validation

```text
candidate source URI
        |
        v
normalize URI ---> member of snapshot source set? --no--> InvalidAnswer
                            |
                           yes
                            v
                     render reference
```

At minimum, structural validation enforces a non-empty bounded message list,
Discord-compatible message lengths, non-empty Source References for substantive
answers, unique normalized references, and membership of every reference in the
Documentation Snapshot's source set (R05, R11). A provider instruction to cite
sources is not itself validation. The semantic grounding evaluation remains
part of provider admission under decision 0005. Final presentation uses the
compact mechanical Sources footer in
[decision 0002](./.decisions/0002-compact-source-footer.md).

The Answer Engine must receive an instruction that the supplied snapshot is its
only factual authority and that uncertainty or refusal is valid. It must never
receive an instruction to answer regardless of available support.

## Corpus Lifecycle

`DocumentationCorpus` retrieves only the canonical endpoint from A01 and emits
a content digest over the exact bytes used by the Answer Engine. A successful
snapshot is immutable for one request. Redirect, content-type, maximum-size,
timeout, retry, and stale-cache behavior are explicit configuration with typed
failure outcomes. A successful public-corpus snapshot may be cached for at most
15 minutes; expiry or refresh failure makes the assistant unavailable rather
than serving stale content
([decision 0003](./.decisions/0003-bounded-public-corpus-cache.md)).

The raw corpus may be cached because it is public documentation. Query and Query
Context content never enter that cache or any other bot-owned persistence
(R09, decision 0006).

## Rendering

`DiscordRenderer` accepts only a validated Grounded Answer. It preserves fenced
code blocks, keeps each Source Reference usable, and partitions content without
splitting a fence across messages. The number and size of messages are bounded
configuration below Discord's current API limits rather than magic numbers in
answer prompts (R11).

The first rendered message edits the deferred interaction response. Remaining
messages, if any, are ordered follow-ups. A partial delivery records the last
successful ordinal so operators can distinguish generation failure from
transport failure (R12).

## Privacy and Observability

Telemetry records request outcome, latency by boundary, selected policy mode,
snapshot digest, engine configuration identity, response count, and failure tag.
It does not record the raw Query, Query Context, usernames, message bodies, or
provider payloads by default (R06, R09). Any higher-content diagnostic mode must
be separately authorized, time bounded, and visible in configuration. It may
not bypass the operations node's categorical ban on content-bearing telemetry.

The provider adapter resolves the environment's service account for the single
dedicated bot project and emits foreground Responses requests with `store:false`
and no tools/background state. A local budget service admits or rejects each
request against configured request/input-token/output-token/cost ceilings before
the provider call. It records content-free usage and never switches project or
model on exhaustion.

No query, provider input/output, answer, or title/excerpt content is persisted.
Per-member quota state uses a keyed one-way correlation and bounded counters
with a maximum 24-hour TTL. Answer Provenance cannot reconstruct content.

## Verification

| Contract | Non-live proof | Composed proof |
| --- | --- | --- |
| Audience policy (R03) | allow/deny table tests | staging identities/roles |
| Context boundary (R07–R09) | generated histories and metadata-redaction assertions | disclosed staging thread |
| Corpus and provenance (R04, R06) | fixed snapshot, redirect/timeout/oversize failures, digest assertion | canonical endpoint retrieval |
| Grounding (R05) | accepted/unknown/malformed Source Reference cases plus evaluation corpus | sampled staging answers |
| Rendering (R11) | boundary lengths, code fences, link and multi-message cases | deferred response plus follow-up |
| Failures (R12) | one injected failure per typed boundary | staging corpus/provider/transport failure exercises |

No live proof uses a production conversation or credential. The staging check
uses an isolated channel, synthetic content, and explicit cleanup.
