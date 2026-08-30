import { Effect, Layer, Schema } from 'effect'

import { DiscordActions, DiscordSnowflake } from '../discord/actions.ts'
import { digestCorpus } from '../docs/corpus.ts'
import {
  AnswerEngine,
  DocumentationSource as DocumentationSourceSchema,
  DocsTelemetry,
  DocumentationCorpus,
  type DocumentationSource,
} from '../docs/index.ts'
import type { ThreadMutationPort } from '../threading/index.ts'

const fakeSource = Schema.decodeUnknownSync(DocumentationSourceSchema)({
  id: 'docs.livestore.dev/overview',
  title: 'LiveStore overview',
  canonicalUrl: 'https://docs.livestore.dev/overview',
  content: 'LiveStore is a local-first data layer. Events are facts which materializers project into state.',
}) satisfies DocumentationSource

export const FakeDiscordActionsLive = Layer.succeed(
  DiscordActions,
  DiscordActions.of({
    deferInteraction: () => Effect.void,
    editInteractionResponse: () => Effect.void,
    followUpInteractionResponse: () => Effect.void,
    respondInteraction: () => Effect.void,
  }),
)

export const fakeThreadMutation: ThreadMutationPort = {
  create: (input) => Effect.succeed(Schema.decodeUnknownSync(DiscordSnowflake)(fakeThreadId(input.messageId))),
}

export const FakeDocsPortsLive = Layer.mergeAll(
  Layer.effect(
    DocumentationCorpus,
    Effect.gen(function* () {
      const content = fakeSource.content
      const digest = yield* digestCorpus(content)
      return DocumentationCorpus.of({
        snapshot: () =>
          Effect.succeed({
            cacheStatus: 'hit' as const,
            snapshot: { digest, retrievedAtMillis: 0, byteLength: content.length, sources: [fakeSource] },
          }),
      })
    }),
  ),
  Layer.succeed(
    AnswerEngine,
    AnswerEngine.of({
      configurationIdentity: 'fake:source-backed:v1',
      answer: (input) =>
        Effect.succeed({
          candidate: {
            supported: true,
            answer: `Fake source-backed answer for: ${input.query}`,
            citations: [fakeSource.id],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
    }),
  ),
  Layer.succeed(DocsTelemetry, DocsTelemetry.of({ emit: () => Effect.void })),
)

const fakeThreadId = (messageId: string) => {
  const value = BigInt(messageId) + 10_000n
  return value.toString().slice(0, 20)
}
