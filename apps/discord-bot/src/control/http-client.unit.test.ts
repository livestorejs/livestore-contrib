import { Cause, Effect, Exit, Schema } from 'effect'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BotControlClient } from './contract.ts'
import { makeHttpsBotControlClient } from './http-client.ts'
import {
  type ControlDependencyUnavailable,
  ControlAuthorizationRejected,
  InvalidControlInput,
  DiscordMessageRef,
  OperatorReason,
  type ControlError as ControlErrorType,
  type ControlResult,
} from './schema.ts'

const baseUrl = 'https://admin.example'
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fetchMock = (): Mock => globalThis.fetch as unknown as Mock
const firstCall = (): { readonly url: string; readonly init: RequestInit } => {
  const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit]
  return { url, init }
}
const firstHeaders = (): Headers => new Headers(firstCall().init.headers)
const firstJsonBody = (): unknown => {
  const raw = firstCall().init.body
  return JSON.parse(typeof raw === 'string' ? raw : '') as unknown
}

const runWithClient = (
  fetchImpl: (...args: Parameters<typeof fetch>) => Promise<Response>,
  op: (client: BotControlClient) => Effect.Effect<unknown, ControlErrorType>,
): Promise<{ success?: unknown; failure?: ControlErrorType }> => {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  return Effect.gen(function* () {
    const client = yield* makeHttpsBotControlClient(baseUrl, 'secret-token')
    const exit = yield* Effect.exit(op(client))
    if (Exit.isSuccess(exit) === true) return { success: exit.value }
    const failure = Cause.findErrorOption(exit.cause)
    return failure._tag === 'Some' ? { failure: failure.value } : {}
  }).pipe(Effect.scoped, Effect.runPromise)
}

const source = Schema.decodeUnknownSync(DiscordMessageRef)({
  guildId: '10000000000000001',
  channelId: '10000000000000002',
  messageId: '10000000000000003',
})
const reason = Schema.decodeUnknownSync(OperatorReason)('operator retry')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HTTPS bot control client', () => {
  it('posts one authenticated request per operation and decodes Success', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'Success', summary: 'config summary', correlationId: 'c1' })),
      (client) => client.RuntimeStatus({}),
    )
    expect(result.success).toEqual({ _tag: 'Success', summary: 'config summary', correlationId: 'c1' })
    const call = firstCall()
    expect(call.init.method).toBe('POST')
    expect(call.url).toBe(`${baseUrl}/admin/rpc/RuntimeStatus`)
    expect(firstHeaders().get('authorization')).toBe('Bearer secret-token')
    expect(firstHeaders().get('content-type')).toBe('application/json')
    expect(firstJsonBody()).toEqual({})
  })

  it('round-trips AlreadySatisfied with thread correlation ids', async () => {
    const body = { _tag: 'AlreadySatisfied', summary: 'thread exists', correlationId: 'corr-7', receiptId: 'r-9' }
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse(body)),
      (client) =>
        client.ThreadCreate({
          source,
          environment: 'staging',
          apply: true,
          reason,
        }),
    )
    expect(result.success).toEqual(body)
    expect(firstCall().url).toBe(`${baseUrl}/admin/rpc/ThreadCreate`)
  })

  it('forwards RuntimeHealth watch:true as an ordinary payload flag', async () => {
    await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'Success', summary: 'healthy' })),
      (client) => client.RuntimeHealth({ watch: true }),
    )
    expect(firstJsonBody()).toEqual({ watch: true })
  })

  it('maps a decodable 401 body to ControlAuthorizationRejected', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'ControlAuthorizationRejected', message: 'bearer token mismatch' }, 401)),
      (client) => client.RuntimeStatus({}),
    )
    expect(result.failure).toMatchObject({
      _tag: 'ControlAuthorizationRejected',
      message: 'bearer token mismatch',
    })
  })

  it('synthesizes ControlAuthorizationRejected for a malformed 401 body', async () => {
    const result = await runWithClient(
      () => Promise.resolve(new Response('<html>nope</html>', { status: 401 })),
      (client) => client.RuntimeStatus({}),
    )
    expect(result.failure).toMatchObject({ _tag: 'ControlAuthorizationRejected' })
    expect(result.failure).toBeInstanceOf(ControlAuthorizationRejected)
  })

  it('maps 400/422 validation failures to InvalidControlInput', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'InvalidControlInput', message: 'payload failed schema validation' }, 422)),
      (client) => client.ThreadCreate({ source, environment: 'staging', apply: true, reason }),
    )
    expect(result.failure).toMatchObject({
      _tag: 'InvalidControlInput',
      message: 'payload failed schema validation',
    })
  })

  it('maps 404 to InvalidControlInput naming the missing route', async () => {
    const result = await runWithClient(
      () => Promise.resolve(new Response('not found', { status: 404 })),
      (client) => client.RuntimeStatus({}),
    )
    expect(result.failure).toMatchObject({ _tag: 'InvalidControlInput', message: 'No such admin operation route' })
    expect(result.failure).toBeInstanceOf(InvalidControlInput)
  })

  it('maps undecodable 5xx bodies to ControlDependencyUnavailable', async () => {
    const result = await runWithClient(
      () => Promise.resolve(new Response('boom', { status: 503 })),
      (client) => client.RuntimeStatus({}),
    )
    expect((result.failure as ControlDependencyUnavailable)._tag).toBe('ControlDependencyUnavailable')
  })

  it('preserves decodable error bodies on unexpected statuses', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'ControlApplicationFailure', message: 'handler defect' }, 409)),
      (client) => client.RuntimeStatus({}),
    )
    expect(result.failure).toMatchObject({ _tag: 'ControlApplicationFailure', message: 'handler defect' })
  })

  it('maps network failure to ControlDependencyUnavailable without throwing', async () => {
    const result = await runWithClient(() => Promise.reject(new TypeError('fetch failed')), (client) =>
      client.RuntimeStatus({}),
    )
    expect((result.failure as ControlDependencyUnavailable).dependency).toBe('admin-endpoint')
  })

  it('synthesizes InvalidControlInput when a 200 body does not decode', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'UnexpectedTag', summary: '' })),
      (client) => client.RuntimeStatus({}),
    )
    expect(result.failure).toMatchObject({ _tag: 'InvalidControlInput', message: 'Malformed admin response' })
    expect(result.failure).toBeInstanceOf(InvalidControlInput)
  })


  it('decodes results against the shared ControlResult schema shape', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'Success', summary: 'snapshot' })),
      (client) => client.RuntimeStatus({}),
    )
    expect(typeof (result.success as ControlResult).summary).toBe('string')
  })
})
