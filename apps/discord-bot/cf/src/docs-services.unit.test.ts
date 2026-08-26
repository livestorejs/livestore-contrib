import { createHmac } from 'node:crypto'

import { expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { DocumentationCorpus } from '../../src/docs/services.ts'
import { makeCanonicalCorpusLayer, canonicalCorpusUrl } from '../../src/docs/corpus.ts'
import { DocsWorkflow } from '../../src/docs/services.ts'

import { makeCrypto } from './crypto.ts'
import { makeFakeDoStorage } from './fake-do-storage.ts'
import { keyValueStoreFromDurableStorage } from './storage.ts'
import { makeKeyValueDocsStateStore } from './docs-state.ts'
import { correlateWithWebCryptoKey, makeDocsServices } from './docs-services.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const corpusFixture = [
  '# [Getting Started](https://docs.livestore.dev/getting-started)',
  'LiveStore is a local-first reactive sync framework.',
  '',
  '# [Schema](https://docs.livestore.dev/schema)',
  'Define tables with Schema.Struct and sqlite-mapped column types.',
  '',
].join('\n')

const candidateFixture = {
  supported: true,
  answer: 'Use Schema.Struct to define your tables.',
  citations: ['docs.livestore.dev/schema'],
}

const openAiBody = JSON.stringify({
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(candidateFixture) }],
    },
  ],
  usage: { input_tokens: 120, output_tokens: 40 },
})

/** Routes by URL substring so both corpus and provider calls stay on localhost-free fakes. */
const stubHttpLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const url = request.url
    const body = url.includes('llms-full') ? corpusFixture : openAiBody
    const contentType = url.includes('llms-full') ? 'text/plain; charset=utf-8' : 'application/json'
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(body, { status: 200, headers: { 'content-type': contentType } })),
    )
  }),
)

const sha256Hex = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

// ---------------------------------------------------------------------------
// Corpus digest over a locally stubbed canonical corpus
// ---------------------------------------------------------------------------

it.effect('digests the canonical corpus served by a stub client without real network', () =>
  Effect.gen(function* () {
    const layer = makeCanonicalCorpusLayer({
      endpoint: 'http://stub.local/llms-full.txt',
      maximumBytes: 1_000_000,
      timeoutMillis: 1_000,
      ttlMillis: 60_000,
    }).pipe(Layer.provide(stubHttpLayer))

    yield* Effect.gen(function* () {
      const corpus = yield* DocumentationCorpus

      const first = yield* corpus.snapshot()
      expect(first.cacheStatus).toBe('miss')
      expect(first.snapshot.sources.map((source) => source.id)).toEqual([
        'docs.livestore.dev/getting-started',
        'docs.livestore.dev/schema',
      ])
      expect(first.snapshot.digest).toBe(`sha256:${yield* Effect.promise(() => sha256Hex(corpusFixture))}`)

      // The TTL cache must serve the second read without re-fetching.
      const second = yield* corpus.snapshot()
      expect(second.cacheStatus).toBe('hit')
      expect(second.snapshot.digest).toBe(first.snapshot.digest)
    }).pipe(Effect.provide(layer))
  }))

// ---------------------------------------------------------------------------
// Admission key generation uniqueness (+ node HMAC parity)
// ---------------------------------------------------------------------------

it.effect('web-crypto admission keys are unique per principal and byte-parity with node HMAC', () =>
  Effect.gen(function* () {
    const key = 'deployment-correlation-key'

    const aliceA = yield* correlateWithWebCryptoKey(key, 'alice')
    const aliceB = yield* correlateWithWebCryptoKey(key, 'alice')
    const bob = yield* correlateWithWebCryptoKey(key, 'bob')

    // Deterministic per principal, distinct across principals, full 64-hex.
    expect(aliceB).toBe(aliceA)
    expect(bob).not.toBe(aliceA)
    expect(aliceA).toMatch(/^[a-f0-9]{64}$/)

    // Runtime parity with the node implementation used on the host.
    expect(aliceA).toBe(createHmac('sha256', key).update('alice').digest('hex'))

    // Ephemeral instance keys never repeat.
    const crypto = makeCrypto()
    const firstKey = yield* crypto.randomBytes(32)
    const secondKey = yield* crypto.randomBytes(32)
    expect(Array.from(firstKey)).not.toEqual(Array.from(secondKey))
  }))

// ---------------------------------------------------------------------------
// Monthly quota reserve/deny over the existing CF docs-state store
// ---------------------------------------------------------------------------

it.effect('the KV-backed docs-state store reserves and denies against the monthly ceiling', () =>
  Effect.gen(function* () {
    const store = makeKeyValueDocsStateStore(keyValueStoreFromDurableStorage(makeFakeDoStorage()), makeCrypto())
    const atMillis = new Date('2026-08-15T12:00:00Z').getTime()

    const reserved = yield* store.reserveMonthly({ atMillis, costUsdMicros: 500, ceilingUsdMicros: 1_000 })
    expect(reserved._tag).toBe('Reserved')
    expect(yield* store.monthlySpent(atMillis + 1)).toBe(500)

    if (reserved._tag !== 'Reserved') return
    yield* store.settleMonthly({ id: reserved.id, outcome: 'charge', costUsdMicros: 400 })
    expect(yield* store.monthlySpent(atMillis + 1)).toBe(400)

    const denied = yield* store.reserveMonthly({ atMillis, costUsdMicros: 700, ceilingUsdMicros: 1_000 })
    expect(denied._tag).toBe('Denied')
  }))

// ---------------------------------------------------------------------------
// Full assembly: handler-facing R satisfied end-to-end
// ---------------------------------------------------------------------------

it.effect('makeDocsServices answers a query and records correlated quota state', () =>
  Effect.gen(function* () {
    const stateStore = makeKeyValueDocsStateStore(keyValueStoreFromDurableStorage(makeFakeDoStorage()), makeCrypto())
    // Luna list pricing on the stubbed usage (120 in / 40 out) is exactly 72 micros.
    const services = makeDocsServices({
      openAiApiKey: 'test-key',
      correlationKey: 'deployment-correlation-key',
      monthlyCostUsdMicros: 10_000_000,
      stateStore,
      httpLayer: stubHttpLayer,
    })

    yield* Effect.gen(function* () {
      const docs = yield* DocsWorkflow

      const result = yield* docs.query({
        surface: 'discord',
        principalId: 'user-42',
        query: 'How do I define a table schema?',
      })
      expect(result._tag).toBe('Answered')
      if (result._tag !== 'Answered') return
      expect(result.citations.map((citation) => citation.id)).toEqual(['docs.livestore.dev/schema'])
      expect(result.corpusDigest).toBe(`sha256:${yield* Effect.promise(() => sha256Hex(corpusFixture))}`)
      expect(result.engineConfiguration).toContain('gpt-5.6-luna')

      const recent = yield* stateStore.recent(Date.now())
      expect(recent.provenance).toHaveLength(1)
      expect(recent.provenance[0]?.inputTokens).toBe(120)
      expect(recent.quota[0]?.principal).toMatch(/^[a-f0-9]{64}$/)
      expect(recent.quota[0]?.costUsdMicros).toBe(72)
      expect(yield* stateStore.monthlySpent(Date.now())).toBe(72)
    }).pipe(Effect.provide(services))
  }))

// The production assembly must target the canonical corpus URL.
it('the canonical corpus endpoint is unchanged', () => {
  expect(canonicalCorpusUrl).toBe('https://docs.livestore.dev/llms-full.txt')
})
