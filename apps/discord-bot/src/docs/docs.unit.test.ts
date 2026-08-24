import { expect, it } from '@effect/vitest'
import { Duration, Effect, Layer, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeDocsAdmission, DocsAdmissionLimits } from './admission.ts'
import { makeCachedCorpus, parseCanonicalCorpus } from './corpus.ts'
import { aiTitleDataUseNotice, docsCommandDescription, docsDataUseNotice } from './disclosure.ts'
import {
  AnswerEngineResult,
  CorpusUnavailable,
  DocumentationSnapshot,
  DocsQueryResult,
  type DocsTelemetryEvent,
} from './domain.ts'
import { makeOpenAiRequest, openAiDocsConfiguration } from './openai.ts'
import { renderDocsMessages } from './render.ts'
import { selectDocumentationSources } from './retrieval.ts'
import { AnswerEngine, DocsTelemetry, DocsWorkflow, DocumentationCorpus } from './services.ts'
import { DocsWorkflowLive, makeDocsWorkflowLayer } from './workflow.ts'
import { makeFileDocsStateStore } from './state.ts'

const snapshot = Schema.decodeUnknownSync(DocumentationSnapshot)({
  digest: `sha256:${'a'.repeat(64)}`,
  retrievedAtMillis: 0,
  byteLength: 200,
  sources: [
    {
      id: 'docs.livestore.dev/reference/schema',
      title: 'Schema',
      canonicalUrl: 'https://docs.livestore.dev/reference/schema',
      content: 'Define events and materializers in a LiveStore schema.',
    },
    {
      id: 'docs.livestore.dev/reference/store',
      title: 'Store',
      canonicalUrl: 'https://docs.livestore.dev/reference/store',
      content: 'Create a store with an adapter and schema.',
    },
  ],
})

it('parses only canonical top-level source headings', () => {
  const parsed = parseCanonicalCorpus(
    [
      '<SYSTEM>documentation</SYSTEM>',
      '# [Schema](https://docs.livestore.dev/reference/schema/)',
      'Schema body.',
      '## [Nested](https://example.com/not-a-source)',
      '# [Store](https://docs.livestore.dev/reference/store/)',
      'Store body.',
    ].join('\n'),
  )

  expect(parsed.map(({ id }) => id)).toEqual([
    'docs.livestore.dev/reference/schema',
    'docs.livestore.dev/reference/store',
  ])
  expect(parsed[0]?.content).toContain('Nested')
})

it('retrieves a deterministic bounded subset', () => {
  const selected = selectDocumentationSources(snapshot, 'How do I define schema events?', {
    maximumSources: 1,
    maximumCharactersPerSource: 24,
    maximumTotalCharacters: 24,
  })

  expect(selected).toHaveLength(1)
  expect(selected[0]?.id).toBe('docs.livestore.dev/reference/schema')
  expect(selected[0]?.content.length).toBeLessThanOrEqual(24)
})

it.effect('caches for the bounded TTL and never serves stale on refresh failure', () =>
  Effect.gen(function* () {
    let calls = 0
    let fail = false
    const load = Effect.suspend(() => {
      calls += 1
      return fail
        ? Effect.fail(new CorpusUnavailable({ reason: 'transport', message: 'synthetic failure' }))
        : Effect.succeed(snapshot)
    })
    const corpus = yield* makeCachedCorpus(load, 1_000)

    expect((yield* corpus.snapshot()).cacheStatus).toBe('miss')
    expect((yield* corpus.snapshot()).cacheStatus).toBe('hit')
    expect(calls).toBe(1)

    fail = true
    yield* TestClock.adjust(Duration.millis(1_000))
    const expired = yield* Effect.result(corpus.snapshot())
    expect(expired._tag).toBe('Failure')
    expect(calls).toBe(2)
  }),
)

it.effect('uses one explicit-query workflow for CLI and Discord without content telemetry', () => {
  const telemetry: Array<DocsTelemetryEvent> = []
  const engineCalls: Array<{ readonly query: string; readonly sourceCount: number }> = []
  const result = Schema.decodeUnknownSync(AnswerEngineResult)({
    candidate: {
      supported: true,
      answer: 'Define events and materializers, then create the store with that schema.',
      citations: ['docs.livestore.dev/reference/schema', 'docs.livestore.dev/reference/store'],
    },
    usage: { inputTokens: 100, outputTokens: 30 },
  })
  const layer = DocsWorkflowLive.pipe(
    Layer.provide([
      Layer.succeed(
        DocumentationCorpus,
        DocumentationCorpus.of({
          snapshot: () => Effect.succeed({ cacheStatus: 'hit', snapshot }),
        }),
      ),
      Layer.succeed(
        AnswerEngine,
        AnswerEngine.of({
          configurationIdentity: 'fake:docs-v1',
          answer: ({ query, sources }) =>
            Effect.sync(() => {
              engineCalls.push({ query, sourceCount: sources.length })
              return result
            }),
        }),
      ),
      Layer.succeed(
        DocsTelemetry,
        DocsTelemetry.of({
          emit: (event) =>
            Effect.sync(() => {
              telemetry.push(event)
            }),
        }),
      ),
    ]),
  )

  return Effect.gen(function* () {
    const workflow = yield* DocsWorkflow
    const privateQuery = 'How do I create a store with a schema? private-7f905'
    const cli = yield* workflow.query({ surface: 'cli', query: ` ${privateQuery} ` })
    const discord = yield* workflow.query({ surface: 'discord', query: privateQuery })

    expect(discord).toEqual(cli)
    expect(engineCalls).toEqual([
      { query: privateQuery, sourceCount: 2 },
      { query: privateQuery, sourceCount: 2 },
    ])
    const serialized = JSON.stringify(telemetry)
    expect(serialized).not.toContain(privateQuery)
    expect(serialized).not.toContain('Define events')
    expect(serialized).not.toContain('https://')
    expect(telemetry.map(({ outcome }) => outcome)).toEqual(['answered', 'answered'])
  }).pipe(Effect.provide(layer))
})

it.effect('fails closed for duplicate or out-of-snapshot citations', () => {
  const candidate = Schema.decodeUnknownSync(AnswerEngineResult)({
    candidate: {
      supported: true,
      answer: 'Invented answer',
      citations: ['not/in/the/snapshot'],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  })
  const layer = DocsWorkflowLive.pipe(
    Layer.provide([
      Layer.succeed(
        DocumentationCorpus,
        DocumentationCorpus.of({
          snapshot: () => Effect.succeed({ cacheStatus: 'miss', snapshot }),
        }),
      ),
      Layer.succeed(
        AnswerEngine,
        AnswerEngine.of({
          configurationIdentity: 'fake:docs-v1',
          answer: () => Effect.succeed(candidate),
        }),
      ),
      Layer.succeed(DocsTelemetry, DocsTelemetry.of({ emit: () => Effect.void })),
    ]),
  )

  return Effect.gen(function* () {
    const workflow = yield* DocsWorkflow
    expect(yield* workflow.query({ surface: 'cli', query: 'schema' })).toEqual({
      _tag: 'Unavailable',
      reason: 'invalid_citation',
    })
  }).pipe(Effect.provide(layer))
})

it('pins the no-storage Luna Responses request and strict output schema', () => {
  const request = makeOpenAiRequest({
    query: 'How do schemas work?',
    corpusDigest: snapshot.digest,
    sources: snapshot.sources,
  })

  expect(request).toMatchObject({
    model: 'gpt-5.6-luna',
    reasoning: { effort: 'medium' },
    store: false,
    background: false,
    max_output_tokens: 2_000,
    tools: [],
    text: { format: { type: 'json_schema', strict: true } },
  })
  expect(request.text.format.schema.properties.citations).toEqual({
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 512 },
  })
  expect(request.text.format.schema.properties.citations).not.toHaveProperty('uniqueItems')
  expect(openAiDocsConfiguration.store).toBe(false)
  expect(docsCommandDescription.length).toBeLessThanOrEqual(100)
  expect(docsDataUseNotice).toContain('does not send ambient Discord history')
  expect(docsDataUseNotice).toContain('not Zero Data Retention')
  expect(aiTitleDataUseNotice).toContain('OpenAI')
  expect(aiTitleDataUseNotice).toContain('store:false')
  expect(aiTitleDataUseNotice).toContain('local title')
})

it.effect('bounds concurrent and rate-limited provider admission with one-way principals', () => Effect.gen(function* () {
  let now = 1_000
  const correlated: Array<string> = []
  const limits = Schema.decodeUnknownSync(DocsAdmissionLimits)({
    maximumConcurrentPerPrincipal: 1,
    maximumConcurrentGlobal: 2,
    maximumRequestsPerPrincipalWindow: 1,
    principalRequestWindowMillis: 1_000,
    maximumRequestsGlobalWindow: 10,
    globalRequestWindowMillis: 1_000,
    maximumInputTokensPerRequest: 100,
    maximumOutputTokensPerRequest: 10,
    maximumTokensPerPrincipalWindow: 100,
    maximumTokensGlobalWindow: 1_000,
    tokenWindowMillis: 10_000,
  })
  const admission = makeDocsAdmission({
    limits,
    now: () => now,
    correlatePrincipal: principalId => {
      correlated.push(principalId)
      return `opaque-${principalId.length}`
    },
  })

  const first = yield* admission.acquire({ principalId: 'private-member-sentinel', estimatedInputTokens: 20 })
  expect(first._tag).toBe('Admitted')
  expect(yield* admission.acquire({ principalId: 'private-member-sentinel', estimatedInputTokens: 20 }))
    .toEqual({ _tag: 'Denied', reason: 'principal_concurrency' })
  if (first._tag === 'Admitted') yield* first.complete({ inputTokens: 20, outputTokens: 5 })
  expect(yield* admission.acquire({ principalId: 'private-member-sentinel', estimatedInputTokens: 20 }))
    .toEqual({ _tag: 'Denied', reason: 'principal_rate' })

  now += 1_001
  const afterWindow = yield* admission.acquire({ principalId: 'private-member-sentinel', estimatedInputTokens: 80 })
  expect(afterWindow).toEqual({ _tag: 'Denied', reason: 'principal_tokens' })
  expect(correlated).toHaveLength(4)
}))

it.effect('shares global concurrency, rate, and token ceilings across principals', () => Effect.gen(function* () {
  let now = 1_000
  const limits = Schema.decodeUnknownSync(DocsAdmissionLimits)({
    ...defaultTestAdmissionLimits,
    maximumConcurrentGlobal: 1,
    maximumRequestsGlobalWindow: 1,
    maximumTokensGlobalWindow: 100,
  })
  const admission = makeDocsAdmission({ limits, now: () => now, correlatePrincipal: value => value })

  const first = yield* admission.acquire({ principalId: 'first', estimatedInputTokens: 10 })
  expect(first._tag).toBe('Admitted')
  expect(yield* admission.acquire({ principalId: 'second', estimatedInputTokens: 10 }))
    .toEqual({ _tag: 'Denied', reason: 'global_concurrency' })
  if (first._tag === 'Admitted') yield* first.complete({ inputTokens: 20, outputTokens: 5 })
  expect(yield* admission.acquire({ principalId: 'second', estimatedInputTokens: 10 }))
    .toEqual({ _tag: 'Denied', reason: 'global_rate' })

  now += 1_001
  expect(yield* admission.acquire({ principalId: 'second', estimatedInputTokens: 70 }))
    .toEqual({ _tag: 'Denied', reason: 'global_tokens' })
}))

it.effect('charges the full reservation when provider usage is unknown', () => Effect.gen(function* () {
  let now = 1_000
  const limits = Schema.decodeUnknownSync(DocsAdmissionLimits)({
    ...defaultTestAdmissionLimits,
    maximumTokensPerPrincipalWindow: 50,
  })
  const admission = makeDocsAdmission({ limits, now: () => now, correlatePrincipal: value => value })
  const first = yield* admission.acquire({ principalId: 'member', estimatedInputTokens: 10 })
  expect(first._tag).toBe('Admitted')
  if (first._tag === 'Admitted') yield* first.complete()

  now += 1_001
  expect(yield* admission.acquire({ principalId: 'member', estimatedInputTokens: 21 }))
    .toEqual({ _tag: 'Denied', reason: 'principal_tokens' })
}))

it.effect('denies oversized input before the provider and emits content-free telemetry', () => {
  const telemetry: Array<DocsTelemetryEvent> = []
  let providerCalls = 0
  const limits = Schema.decodeUnknownSync(DocsAdmissionLimits)({
    ...defaultTestAdmissionLimits,
    maximumInputTokensPerRequest: 1,
  })
  const layer = makeDocsWorkflowLayer({ limits, correlatePrincipal: () => 'opaque-principal' }).pipe(
    Layer.provide([
      Layer.succeed(DocumentationCorpus, DocumentationCorpus.of({
        snapshot: () => Effect.succeed({ cacheStatus: 'hit', snapshot }),
      })),
      Layer.succeed(AnswerEngine, AnswerEngine.of({
        configurationIdentity: 'fake:docs-v1',
        answer: () => Effect.sync(() => {
          providerCalls += 1
          return Schema.decodeUnknownSync(AnswerEngineResult)({
            candidate: { supported: false, answer: 'unused', citations: [] },
            usage: { inputTokens: 0, outputTokens: 0 },
          })
        }),
      })),
      Layer.succeed(DocsTelemetry, DocsTelemetry.of({
        emit: event => Effect.sync(() => { telemetry.push(event) }),
      })),
    ]),
  )

  return Effect.gen(function* () {
    const workflow = yield* DocsWorkflow
    const result = yield* workflow.query({
      surface: 'discord',
      principalId: 'private-member-sentinel',
      query: 'private-query-sentinel',
    })
    expect(result).toEqual({ _tag: 'Unavailable', reason: 'admission_denied' })
    expect(providerCalls).toBe(0)
    expect(telemetry).toMatchObject([{ outcome: 'admission_denied', admissionDenial: 'input_too_large' }])
    expect(JSON.stringify(telemetry)).not.toContain('private-member-sentinel')
    expect(JSON.stringify(telemetry)).not.toContain('private-query-sentinel')
  }).pipe(Effect.provide(layer))
})

it.effect('cancels a monthly reservation when local admission denies', () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'livestore-docs-workflow-budget-'))),
    root => {
      const stateStore = makeFileDocsStateStore(root, () => 2_000_000)
      const layer = makeDocsWorkflowLayer({
        limits: Schema.decodeUnknownSync(DocsAdmissionLimits)({ ...defaultTestAdmissionLimits, maximumInputTokensPerRequest: 1 }),
        stateStore,
        monthlyCostUsdMicros: 1_000_000,
      }).pipe(Layer.provide([
        Layer.succeed(DocumentationCorpus, DocumentationCorpus.of({ snapshot: () => Effect.succeed({ cacheStatus: 'hit', snapshot }) })),
        Layer.succeed(AnswerEngine, AnswerEngine.of({
          configurationIdentity: 'fake:docs-v1',
          answer: () => Effect.die('provider must not be called'),
        })),
        Layer.succeed(DocsTelemetry, DocsTelemetry.of({ emit: () => Effect.void })),
      ]))
      return Effect.gen(function* () {
        const workflow = yield* DocsWorkflow
        expect(yield* workflow.query({ surface: 'cli', query: 'schema' })).toEqual({ _tag: 'Unavailable', reason: 'admission_denied' })
        expect(yield* stateStore.monthlySpent(2_000_000)).toBe(0)
      }).pipe(Effect.provide(layer))
    },
    root => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ),
)

it('renders bounded Discord follow-ups without splitting a code fence', () => {
  const result = Schema.decodeUnknownSync(DocsQueryResult)({
    _tag: 'Answered',
    answer: `Use this example:\n\n\`\`\`ts\n${'const value = 1\n'.repeat(8)}\`\`\``,
    citations: [
      {
        id: snapshot.sources[0].id,
        canonicalUrl: snapshot.sources[0].canonicalUrl,
      },
    ],
    corpusDigest: snapshot.digest,
    engineConfiguration: 'fake:docs-v1',
  })
  const rendered = renderDocsMessages(result, { maximumMessageCharacters: 90, maximumMessages: 8 })

  expect(rendered._tag).toBe('Rendered')
  if (rendered._tag === 'Rendered') {
    expect(rendered.messages.every((message) => message.length <= 90)).toBe(true)
    expect(rendered.messages.every((message) => (message.match(/```/g)?.length ?? 0) % 2 === 0)).toBe(true)
    expect(rendered.messages.join('\n')).toContain('Sources:')
  }
})

const defaultTestAdmissionLimits = {
  maximumConcurrentPerPrincipal: 1,
  maximumConcurrentGlobal: 2,
  maximumRequestsPerPrincipalWindow: 10,
  principalRequestWindowMillis: 1_000,
  maximumRequestsGlobalWindow: 20,
  globalRequestWindowMillis: 1_000,
  maximumInputTokensPerRequest: 1_000,
  maximumOutputTokensPerRequest: 10,
  maximumTokensPerPrincipalWindow: 10_000,
  maximumTokensGlobalWindow: 20_000,
  tokenWindowMillis: 10_000,
}
