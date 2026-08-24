import { it } from '@effect/vitest'
import { Effect, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http'
import { expect } from 'vitest'

import { makeOpenAiThreadTitlePort, makeOpenAiTitleRequest, openAiTitleConfiguration } from './openai-title.ts'

const apiKey = Redacted.make('test-only-key')

it('pins a foreground no-storage Luna request with a strict title schema', () => {
  const request = makeOpenAiTitleRequest('How can stores synchronize across browser tabs?')

  expect(request).toMatchObject({
    model: 'gpt-5.6-luna',
    reasoning: { effort: 'medium' },
    store: false,
    background: false,
    tools: [],
    text: {
      format: {
        type: 'json_schema',
        name: 'livestore_discord_thread_title_v1',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['title'],
          properties: { title: { type: 'string', minLength: 1, maxLength: 100 } },
        },
      },
    },
  })
  expect(openAiTitleConfiguration.endpoint).toBe('https://api.openai.com/v1/responses')
})

it('places only the supplied projected string beside fixed instructions', () => {
  const projected = 'Discuss sync with [user] using [link]'
  const serialized = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(makeOpenAiTitleRequest(projected))

  expect(serialized.match(new RegExp(projected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
  for (const excluded of [
    'guild-secret-91d4',
    'channel-secret-91d4',
    'user-secret-91d4',
    'attachment-secret-91d4',
    'operator-secret-91d4',
  ])
    expect(serialized).not.toContain(excluded)
})

it.effect('decodes a strict structured title from the Responses envelope', () =>
  Effect.gen(function* () {
    const port = yield* makePortWithResponse(200, responseEnvelope(jsonString({ title: 'Cross-tab sync' })))
    expect(yield* port.propose('How does sync work?')).toBe('Cross-tab sync')
  }),
)

it.effect('returns content-free typed status and decode failures', () =>
  Effect.gen(function* () {
    const privateInput = 'private-title-input-8f2e'
    const statusPort = yield* makePortWithResponse(429, { error: { message: privateInput } })
    const status = yield* Effect.result(statusPort.propose(privateInput))
    expect(status._tag).toBe('Failure')
    if (status._tag === 'Failure') {
      expect(status.failure.code).toBe('status')
      expect(jsonString(status.failure)).not.toContain(privateInput)
    }

    const decodePort = yield* makePortWithResponse(
      200,
      responseEnvelope(jsonString({ title: 'Valid', unexpected: privateInput })),
    )
    const decode = yield* Effect.result(decodePort.propose(privateInput))
    expect(decode._tag).toBe('Failure')
    if (decode._tag === 'Failure') {
      expect(decode.failure.code).toBe('decode')
      expect(jsonString(decode.failure)).not.toContain(privateInput)
    }
  }),
)

it.effect('distinguishes timeout from transport and rejects out-of-bound input before I/O', () =>
  Effect.gen(function* () {
    let attempts = 0
    const neverClient = HttpClient.make(() => {
      attempts += 1
      return Effect.never
    })
    const port = yield* makeOpenAiThreadTitlePort({ apiKey, timeoutMillis: 0 }).pipe(
      Effect.provideService(HttpClient.HttpClient, neverClient),
    )
    const timeout = yield* Effect.result(port.propose('A valid projected input'))
    expect(timeout._tag).toBe('Failure')
    if (timeout._tag === 'Failure') expect(timeout.failure.code).toBe('timeout')

    const transportClient = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: 'synthetic transport failure' }),
        }),
      ),
    )
    const transportPort = yield* makeOpenAiThreadTitlePort({ apiKey }).pipe(
      Effect.provideService(HttpClient.HttpClient, transportClient),
    )
    const transport = yield* Effect.result(transportPort.propose('A valid projected input'))
    expect(transport._tag).toBe('Failure')
    if (transport._tag === 'Failure') expect(transport.failure.code).toBe('transport')

    const invalid = yield* Effect.result(port.propose('x'.repeat(501)))
    expect(invalid._tag).toBe('Failure')
    if (invalid._tag === 'Failure') expect(invalid.failure.code).toBe('decode')
    expect(attempts).toBe(1)
  }),
)

const makePortWithResponse = (status: number, body: unknown) => {
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(jsonString(body), { status, headers: { 'content-type': 'application/json' } }),
      ),
    ),
  )
  return makeOpenAiThreadTitlePort({ apiKey }).pipe(Effect.provideService(HttpClient.HttpClient, client))
}

const responseEnvelope = (text: string) => ({
  id: 'response-provider-field-is-allowed',
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text }],
    },
  ],
})

const jsonString = (value: unknown) => Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value)
