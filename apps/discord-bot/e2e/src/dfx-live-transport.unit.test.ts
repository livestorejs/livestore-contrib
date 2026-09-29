import { inspect } from 'node:util'

import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http'
import { vi } from 'vitest'
import { describe, expect, it } from 'vitest'

import { safeDiscordFailureMessage } from '../../src/discord/rest-error-redaction.ts'
import { makeDfxLiveTransport, operatorCreateThreadArguments } from './dfx-live-transport.ts'
import { topicSentinel, type Snowflake, type StagingTarget } from './model.ts'

const target: StagingTarget = {
  applicationId: '444444444444444444' as Snowflake,
  guildId: '111111111111111111' as Snowflake,
  channelId: '222222222222222222' as Snowflake,
  docsChannelIds: {
    public: '222222222222222222' as Snowflake,
    restricted: '333333333333333333' as Snowflake,
  },
  allowedChannelIds: new Set(['222222222222222222' as Snowflake, '333333333333333333' as Snowflake]),
  requiredTopicSentinel: topicSentinel,
  pollIntervalMs: 1,
  timeoutMs: 4,
}

describe('DFX live transport operator boundary', () => {
  it('routes every control request through the exact manifest socket', () => {
    const args = operatorCreateThreadArguments({
      target,
      sourceMessageId: '333333333333333333' as Snowflake,
      reason: 'correlated test',
      botControlSocket: '/run/discord-bot/staging/isolated.sock',
    })

    expect(args).toContain('--socket')
    expect(args[args.indexOf('--socket') + 1]).toBe('/run/discord-bot/staging/isolated.sock')
    expect(args).not.toContain('/run/discord-bot/control.sock')
  })

  it('drops request credentials before failed DFX REST reaches process output', async () => {
    const token = 'FAKE_ACTOR_TOKEN_NEVER_LOG_123456'
    const client = HttpClient.make((request) => {
      expect(request.headers.authorization).toBe(`Bot ${token}`)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('denied', { status: 403 })))
    })
    const live = makeDfxLiveTransport({
      target,
      actorBotToken: token,
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
    })
    const stderr: string[] = []
    const stdout: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map((arg) => inspect(arg)).join(' '))
    })
    try {
      try {
        await live.transport.inspectChannel(target.channelId)
        throw new Error('Expected Discord 403')
      } catch (error) {
        expect(error).toMatchObject({ _tag: 'DiscordRestFailure', method: 'GET', status: 403 })
        process.stderr.write(`${safeDiscordFailureMessage(error)}\n`)
        console.error(error)
        expect(inspect(error)).not.toContain(token)
      }
      const output = [...stdout, ...stderr].join('')
      expect(output).toContain('Discord REST GET /api/* 403 DecodeError')
      expect(output).not.toContain(token)
      expect(output).not.toContain(`Bot ${token}`)
      expect(output).not.toContain('denied')
    } finally {
      stderrSpy.mockRestore()
      stdoutSpy.mockRestore()
      consoleSpy.mockRestore()
      await live.dispose()
    }
  })

  it('preserves a decoded Discord 404 status without carrying its request or body', async () => {
    const token = 'FAKE_NOT_FOUND_TOKEN_NEVER_LOG_123456'
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ message: `Unknown Channel Bot ${token}`, code: 10003 }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    )
    const live = makeDfxLiveTransport({
      target,
      actorBotToken: token,
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
    })
    try {
      const failure: unknown = await live.transport.inspectChannel(target.channelId).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toMatchObject({ _tag: 'DiscordRestFailure', method: 'GET', status: 404 })
      expect(inspect(failure)).not.toContain(token)
    } finally {
      await live.dispose()
    }
  })

  it('never renders a rejected transport cause containing the bot credential', async () => {
    const token = 'FAKE_TRANSPORT_TOKEN_NEVER_LOG_123456'
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error(`Authorization: Bot ${token}`),
          }),
        }),
      ),
    )
    const live = makeDfxLiveTransport({
      target,
      actorBotToken: token,
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
    })
    try {
      const failure: unknown = await live.transport.inspectChannel(target.channelId).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toMatchObject({
        _tag: 'DiscordRestFailure',
        method: 'GET',
        errorClass: 'TransportError',
      })
      expect(inspect(failure)).not.toContain(token)
      expect(safeDiscordFailureMessage(failure)).not.toContain(token)
    } finally {
      await live.dispose()
    }
  })
  it('deletes human sources and responses as the actor, resolving ledger entries only after REST succeeds', async () => {
    const sourceId = '444444444444444444' as Snowflake
    const responseId = '555555555555555555' as Snowflake
    const requests: string[] = []
    const resolved: string[] = []
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`)
      expect(request.headers.authorization).toBe('Bot actor-token')
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    })
    const live = makeDfxLiveTransport({
      target,
      actorBotToken: 'actor-token',
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
      createHumanMessage: async ({ channelId, marker }) => ({ id: sourceId, channelId, marker, author: 'human' }),
      invokeDocs: async ({ channelId, marker }) => ({
        _tag: 'Answered',
        responses: [{ id: responseId, channelId, marker, hasAnswer: true, hasSources: true }],
      }),
      resolveHumanMessage: async (message) => {
        resolved.push(`message:${message.id}`)
      },
      resolveHumanResponse: async (response) => {
        resolved.push(`response:${response.id}`)
      },
    })
    try {
      await live.transport.createMessage({
        channelId: target.channelId,
        marker: 'marker',
        content: 'marker',
        author: 'human',
      })
      await live.transport.invokeDocs({
        channelId: target.channelId,
        marker: 'marker',
        query: 'sync',
        location: 'public',
        persona: 'member',
      })
      await live.transport.deleteResponse(target.channelId, responseId)
      await live.transport.deleteMessage(target.channelId, sourceId)
      expect(requests).toEqual([
        `DELETE https://discord.com/api/v10/channels/${target.channelId}/messages/${responseId}`,
        `DELETE https://discord.com/api/v10/channels/${target.channelId}/messages/${sourceId}`,
      ])
      expect(resolved).toEqual([`response:${responseId}`, `message:${sourceId}`])
    } finally {
      await live.dispose()
    }
  })

  it('accepts an already-deleted source but preserves REST failures for the receipt', async () => {
    const sourceId = '444444444444444444' as Snowflake
    let status = 404
    const resolved: string[] = []
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              message: 'opaque',
              code: status === 404 ? 10008 : 50013,
            }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    )
    const live = makeDfxLiveTransport({
      target,
      actorBotToken: 'actor-token',
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
      createHumanMessage: async ({ channelId, marker }) => ({ id: sourceId, channelId, marker, author: 'human' }),
      resolveHumanMessage: async (message) => {
        resolved.push(message.id)
      },
    })
    try {
      await live.transport.createMessage({
        channelId: target.channelId,
        marker: 'marker',
        content: 'marker',
        author: 'human',
      })
      status = 403
      await expect(live.transport.deleteMessage(target.channelId, sourceId)).rejects.toMatchObject({
        status: 403,
        discordCode: 50013,
      })
      expect(resolved).toEqual([])
      status = 404
      await live.transport.deleteMessage(target.channelId, sourceId)
      expect(resolved).toEqual([sourceId])
    } finally {
      await live.dispose()
    }
  })
})
