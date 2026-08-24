import { Schema } from 'effect'

const NonEmptyTrimmedString = Schema.Trimmed.check(Schema.isNonEmpty())
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const DocsSurface = Schema.Literals(['cli', 'discord']).annotate({
  identifier: 'DiscordBot.Docs.Surface',
})
export type DocsSurface = typeof DocsSurface.Type

export const CorpusDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
  .pipe(Schema.brand('CorpusDigest'))
  .annotate({ identifier: 'DiscordBot.Docs.CorpusDigest' })
export type CorpusDigest = typeof CorpusDigest.Type

export const SourceId = NonEmptyTrimmedString.check(Schema.isMaxLength(512))
  .pipe(Schema.brand('DocsSourceId'))
  .annotate({ identifier: 'DiscordBot.Docs.SourceId' })
export type SourceId = typeof SourceId.Type

export const CanonicalUrl = Schema.String.check(Schema.isPattern(/^https:\/\//), Schema.isMaxLength(2_048))
  .pipe(Schema.brand('DocsCanonicalUrl'))
  .annotate({ identifier: 'DiscordBot.Docs.CanonicalUrl' })
export type CanonicalUrl = typeof CanonicalUrl.Type

export const DocumentationSource = Schema.Struct({
  id: SourceId,
  title: NonEmptyTrimmedString.check(Schema.isMaxLength(512)),
  canonicalUrl: CanonicalUrl,
  content: Schema.NonEmptyString,
}).annotate({ identifier: 'DiscordBot.Docs.DocumentationSource' })
export type DocumentationSource = typeof DocumentationSource.Type

export const DocumentationSnapshot = Schema.Struct({
  digest: CorpusDigest,
  retrievedAtMillis: NonNegativeInt,
  byteLength: NonNegativeInt,
  sources: Schema.NonEmptyArray(DocumentationSource),
}).annotate({ identifier: 'DiscordBot.Docs.DocumentationSnapshot' })
export type DocumentationSnapshot = typeof DocumentationSnapshot.Type

export const CorpusCacheStatus = Schema.Literals(['hit', 'miss'])
export type CorpusCacheStatus = typeof CorpusCacheStatus.Type

export const CorpusSnapshotResult = Schema.Struct({
  cacheStatus: CorpusCacheStatus,
  snapshot: DocumentationSnapshot,
})
export type CorpusSnapshotResult = typeof CorpusSnapshotResult.Type

export const DocsQueryInput = Schema.Struct({
  surface: DocsSurface,
  /** Transient admission identity; it is one-way correlated before entering quota state. */
  principalId: Schema.optional(NonEmptyTrimmedString.check(Schema.isMaxLength(256))),
  query: Schema.String,
  refreshCorpus: Schema.optional(Schema.Boolean),
}).annotate({ identifier: 'DiscordBot.Docs.QueryInput' })
export type DocsQueryInput = typeof DocsQueryInput.Type

export const AnswerCandidate = Schema.Struct({
  supported: Schema.Boolean,
  answer: NonEmptyTrimmedString.check(Schema.isMaxLength(12_000)),
  citations: Schema.Array(SourceId),
}).annotate({ identifier: 'DiscordBot.Docs.AnswerCandidate' })
export type AnswerCandidate = typeof AnswerCandidate.Type

export const AnswerUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
}).annotate({ identifier: 'DiscordBot.Docs.AnswerUsage' })
export type AnswerUsage = typeof AnswerUsage.Type

export const AnswerEngineResult = Schema.Struct({
  candidate: AnswerCandidate,
  usage: AnswerUsage,
})
export type AnswerEngineResult = typeof AnswerEngineResult.Type

export const AnswerReference = Schema.Struct({
  id: SourceId,
  canonicalUrl: CanonicalUrl,
})
export type AnswerReference = typeof AnswerReference.Type

export const DocsAnswered = Schema.TaggedStruct('Answered', {
  answer: NonEmptyTrimmedString,
  citations: Schema.NonEmptyArray(AnswerReference),
  corpusDigest: CorpusDigest,
  engineConfiguration: NonEmptyTrimmedString,
})

export const DocsUnsupported = Schema.TaggedStruct('Unsupported', {
  explanation: NonEmptyTrimmedString,
  corpusDigest: CorpusDigest,
  engineConfiguration: NonEmptyTrimmedString,
})

export const DocsUnavailableReason = Schema.Literals([
  'invalid_query',
  'admission_denied',
  'corpus_unavailable',
  'provider_unavailable',
  'invalid_provider_output',
  'invalid_citation',
])
export type DocsUnavailableReason = typeof DocsUnavailableReason.Type

export const DocsUnavailable = Schema.TaggedStruct('Unavailable', {
  reason: DocsUnavailableReason,
})

export const DocsQueryResult = Schema.Union([DocsAnswered, DocsUnsupported, DocsUnavailable]).annotate({
  identifier: 'DiscordBot.Docs.QueryResult',
})
export type DocsQueryResult = typeof DocsQueryResult.Type

export const DocsOutcome = Schema.Literals([
  'answered',
  'unsupported',
  'invalid_query',
  'admission_denied',
  'corpus_unavailable',
  'provider_unavailable',
  'invalid_provider_output',
  'invalid_citation',
])
export type DocsOutcome = typeof DocsOutcome.Type

/** Deliberately content-free: this schema has no query, answer, URL, or excerpt field. */
export const DocsTelemetryEvent = Schema.TaggedStruct('DocsQueryCompleted', {
  surface: DocsSurface,
  outcome: DocsOutcome,
  cacheStatus: Schema.Literals(['hit', 'miss', 'not_consulted']),
  corpusDigest: Schema.optional(CorpusDigest),
  engineConfiguration: Schema.optional(NonEmptyTrimmedString),
  sourceCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  admissionDenial: Schema.optional(Schema.Literals([
    'input_too_large',
    'principal_concurrency',
    'global_concurrency',
    'principal_rate',
    'global_rate',
    'principal_tokens',
    'global_tokens',
    'monthly_cost',
  ])),
})
export type DocsTelemetryEvent = typeof DocsTelemetryEvent.Type

export class CorpusUnavailable extends Schema.TaggedError<CorpusUnavailable>()('CorpusUnavailable', {
  reason: Schema.Literals(['transport', 'status', 'redirect', 'content_type', 'oversize', 'empty', 'invalid']),
  message: NonEmptyTrimmedString,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class AnswerEngineFailure extends Schema.TaggedError<AnswerEngineFailure>()('AnswerEngineFailure', {
  reason: Schema.Literals(['transport', 'status', 'decode', 'empty_output']),
  message: NonEmptyTrimmedString,
}) {}
