import { Clock, Duration, Effect, Layer, Schema, SynchronizedRef } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import {
  CanonicalUrl,
  CorpusDigest,
  type CorpusSnapshotResult,
  CorpusUnavailable,
  type DocumentationSnapshot,
  type DocumentationSource,
  SourceId,
} from './domain.ts'
import { DocumentationCorpus } from './services.ts'
import type { DocumentationCorpusService } from './services.ts'

export const canonicalCorpusUrl = 'https://docs.livestore.dev/llms-full.txt'
export const corpusSnapshotTtlMillis = 15 * 60 * 1_000

export interface CanonicalCorpusConfig {
  readonly endpoint: string
  readonly maximumBytes: number
  readonly timeoutMillis: number
  readonly ttlMillis: number
}

export const defaultCanonicalCorpusConfig: CanonicalCorpusConfig = {
  endpoint: canonicalCorpusUrl,
  maximumBytes: 1_000_000,
  timeoutMillis: 15_000,
  ttlMillis: corpusSnapshotTtlMillis,
}

interface CachedSnapshot {
  readonly snapshot: DocumentationSnapshot
  readonly expiresAtMillis: number
}

const SourceHeading = /^# \[([^\]]+)]\((https:\/\/[^)]+)\)\s*$/gm

/** Splits the aggregate into its canonical top-level page records without inventing URLs. */
export const parseCanonicalCorpus = (content: string): ReadonlyArray<DocumentationSource> => {
  const matches = [...content.matchAll(SourceHeading)]
  return matches.flatMap((match, index) => {
    const title = match[1]?.trim()
    const canonicalUrl = match[2]?.trim()
    const start = match.index
    const end = matches[index + 1]?.index ?? content.length
    if (title === undefined || title.length === 0 || canonicalUrl === undefined || start === undefined) return []
    const section = content.slice(start, end).trim()
    if (section.length === 0) return []
    const url = new URL(canonicalUrl)
    const idInput = `${url.hostname}${url.pathname}`.replace(/\/$/, '')
    return [
      {
        id: Schema.decodeUnknownSync(SourceId)(idInput),
        title,
        canonicalUrl: Schema.decodeUnknownSync(CanonicalUrl)(canonicalUrl),
        content: section,
      },
    ]
  })
}

export const digestCorpus = Effect.fn('docs.corpus.digest')(function* (content: string) {
  const bytes = new TextEncoder().encode(content)
  const digest = yield* Effect.tryPromise({
        // Bare global `crypto` (not `globalThis.crypto`): the Workers types
    // declare it as a global binding, which `typeof globalThis` does not see.
    try: () => crypto.subtle.digest('SHA-256', bytes),
    catch: (cause) =>
      new CorpusUnavailable({
        reason: 'invalid',
        message: 'Could not compute the documentation corpus digest',
        cause,
      }),
  })
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return yield* Schema.decodeUnknownEffect(CorpusDigest)(`sha256:${hex}`).pipe(
    Effect.mapError(
      (cause) =>
        new CorpusUnavailable({
          reason: 'invalid',
          message: 'Could not encode the documentation corpus digest',
          cause,
        }),
    ),
  )
})

export const loadCanonicalSnapshot = Effect.fn('docs.corpus.load')(function* (
  client: HttpClient.HttpClient,
  config: CanonicalCorpusConfig = defaultCanonicalCorpusConfig,
) {
  const retrievedAtMillis = yield* Clock.currentTimeMillis
  const response = yield* client.get(config.endpoint).pipe(
    Effect.timeout(Duration.millis(config.timeoutMillis)),
    Effect.mapError(
      (cause) =>
        new CorpusUnavailable({
          reason: 'transport',
          message: 'The canonical documentation corpus could not be retrieved',
          cause,
        }),
    ),
  )
  if (response.status >= 300 && response.status < 400) {
    return yield* new CorpusUnavailable({
      reason: 'redirect',
      message: `The canonical documentation corpus redirected with HTTP ${response.status}`,
    })
  }
  if (response.status !== 200) {
    return yield* new CorpusUnavailable({
      reason: 'status',
      message: `The canonical documentation corpus returned HTTP ${response.status}`,
    })
  }
  const contentType = response.headers['content-type']?.toLowerCase() ?? ''
  if (contentType.startsWith('text/plain') === false) {
    return yield* new CorpusUnavailable({
      reason: 'content_type',
      message: `The canonical corpus returned unsupported content type ${contentType || 'missing'}`,
    })
  }
  const content = yield* response.text.pipe(
    Effect.mapError(
      (cause) =>
        new CorpusUnavailable({
          reason: 'transport',
          message: 'The canonical documentation corpus body could not be read',
          cause,
        }),
    ),
  )
  const byteLength = new TextEncoder().encode(content).byteLength
  if (byteLength > config.maximumBytes) {
    return yield* new CorpusUnavailable({
      reason: 'oversize',
      message: `The canonical documentation corpus exceeded ${config.maximumBytes} bytes`,
    })
  }
  if (content.trim().length === 0) {
    return yield* new CorpusUnavailable({ reason: 'empty', message: 'The canonical documentation corpus was empty' })
  }
  const sources = parseCanonicalCorpus(content)
  const [firstSource, ...remainingSources] = sources
  if (firstSource === undefined) {
    return yield* new CorpusUnavailable({
      reason: 'invalid',
      message: 'The canonical documentation corpus contained no source headings',
    })
  }
  const digest = yield* digestCorpus(content)
  return {
    digest,
    retrievedAtMillis,
    byteLength,
    sources: [firstSource, ...remainingSources],
  } satisfies DocumentationSnapshot
})

export const makeCanonicalCorpusLayer = (config: CanonicalCorpusConfig = defaultCanonicalCorpusConfig) =>
  Layer.effect(
    DocumentationCorpus,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* makeCachedCorpus(loadCanonicalSnapshot(client, config), config.ttlMillis)
    }),
  )

/** Serializes refreshes so concurrent callers share one fresh immutable snapshot. */
export const makeCachedCorpus = (
  load: Effect.Effect<DocumentationSnapshot, CorpusUnavailable>,
  ttlMillis = corpusSnapshotTtlMillis,
): Effect.Effect<DocumentationCorpusService> =>
  Effect.gen(function* () {
    const cache = yield* SynchronizedRef.make<CachedSnapshot | undefined>(undefined)
    const snapshot = Effect.fn('docs.corpus.snapshot')(function* (options?: { readonly refresh?: boolean }) {
      const now = yield* Clock.currentTimeMillis
      return yield* SynchronizedRef.modifyEffect(
        cache,
        (current): Effect.Effect<readonly [CorpusSnapshotResult, CachedSnapshot | undefined], CorpusUnavailable> => {
          if (options?.refresh !== true && current !== undefined && now < current.expiresAtMillis) {
            const result: CorpusSnapshotResult = { cacheStatus: 'hit', snapshot: current.snapshot }
            return Effect.succeed([result, current] as const)
          }
          return load.pipe(
            Effect.map((loaded) => {
              const result: CorpusSnapshotResult = { cacheStatus: 'miss', snapshot: loaded }
              return [result, { snapshot: loaded, expiresAtMillis: now + ttlMillis }] as const
            }),
          )
        },
      )
    })
    return DocumentationCorpus.of({ snapshot })
  })
