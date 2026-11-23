import { Cause, Effect, Exit, Schema } from 'effect'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../cli/run.ts'
import { adminRoutes } from '../runtime/admin-routes.ts'
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

const source = Schema.decodeSync(DiscordMessageRef)({
  guildId: '10000000000000001',
  channelId: '10000000000000002',
  messageId: '10000000000000003',
})
const reason = Schema.decodeSync(OperatorReason)('operator retry')

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
    expect(call.url).toBe(`${baseUrl}${adminRoutes.runtimeStatus.path}`)
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
    expect(firstCall().url).toBe(`${baseUrl}${adminRoutes.threadCreate.path}`)
  })

  it('fails locally for socket-only operations instead of posting nonexistent routes', async () => {
    const result = await runWithClient(
      () => Promise.reject(new Error('unsupported operation must not fetch')),
      (client) => client.RuntimeHealth({ watch: true }),
    )
    expect(result.failure).toMatchObject({
      _tag: 'ControlDependencyUnavailable',
      message: 'RuntimeHealth is not supported by the HTTPS admin plane',
    })
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('executes supported CLI commands over the Worker admin paths', async () => {
    const requests: Request[] = []
    const result = await runWithClient(
      (url, init) => {
        const request = new Request(url, init)
        requests.push(request.clone())
        const route = `${request.method} ${new URL(request.url).pathname}`
        switch (route) {
          case 'POST /admin/rpc/ThreadCreate':
            return Promise.resolve(jsonResponse({ _tag: 'Success', summary: 'thread created' }))
          case 'POST /admin/rpc/ThreadReconcile':
            return Promise.resolve(jsonResponse({ _tag: 'Planned', summary: 'reconciliation planned' }))
          case 'POST /admin/rpc/RuntimeStatus':
            return Promise.resolve(
              jsonResponse(
                {
                  _tag: 'ControlDependencyUnavailable',
                  dependency: 'runtime-status-source',
                  message: 'No runtime status source',
                },
                503,
              ),
            )
          case 'GET /admin/config':
            return Promise.resolve(
              jsonResponse({
                _tag: 'Success',
                summary: 'config ready',
                running: {
                  summary: {
                    environment: 'staging',
                    applicationId: '1541431832195633232',
                    guildId: '1154415661842452532',
                  },
                },
              }),
            )
          case 'POST /admin/commands-sync':
            return Promise.resolve(jsonResponse({ _tag: 'AlreadySatisfied', summary: 'commands up to date' }))
          default:
            return Promise.resolve(
              jsonResponse({ _tag: 'InvalidControlInput', message: 'No such admin operation route' }, 404),
            )
        }
      },
      (client) =>
        Effect.gen(function* () {
          const output: string[] = []
          const io = {
            stdout: (line: string) => {
              output.push(line)
            },
            stderr: (line: string) => {
              output.push(line)
            },
            isTTY: false,
          }
          const commands = [
            [
              'thread',
              'create',
              'https://discord.com/channels/10000000000000001/10000000000000002/10000000000000003',
              '--environment',
              'staging',
              '--apply',
              '--reason',
              'operator retry',
            ],
            ['thread', 'reconcile', '--all'],
            ['runtime', 'status'],
            ['config', 'show'],
            ['commands', 'sync', '--environment', 'staging', '--apply', '--reason', 'operator retry'],
          ]
          for (const args of commands) {
            const code = yield* runCli(args, client, io)
            if (args[0] === 'runtime') expect(code).toBe(4) // No runtime snapshot is wired into this router.
            else expect(code).toBe(0)
          }
          return output
        }),
    )
    expect(result.failure).toBeUndefined()
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      [adminRoutes.threadCreate.method, adminRoutes.threadCreate.path],
      [adminRoutes.threadReconcile.method, adminRoutes.threadReconcile.path],
      [adminRoutes.runtimeStatus.method, adminRoutes.runtimeStatus.path],
      [adminRoutes.configGet.method, adminRoutes.configGet.path],
      [adminRoutes.configGet.method, adminRoutes.configGet.path],
      [adminRoutes.commandsSync.method, adminRoutes.commandsSync.path],
    ])
    for (const request of requests) expect(request.headers.get('authorization')).toBe('Bearer secret-token')
    expect(requests[3]!.headers.get('content-type')).toBeNull()
    expect(await requests[3]!.text()).toBe('')
    expect(await requests[5]!.json()).toEqual({
      environment: 'staging',
      apply: true,
      reason: 'operator retry',
      expectedApplicationId: '1541431832195633232',
      expectedGuildId: '1154415661842452532',
    })
    expect(result.success).toContainEqual(JSON.stringify({ _tag: 'Success', summary: 'config ready' }))
    expect(result.success).toContainEqual(JSON.stringify({ _tag: 'AlreadySatisfied', summary: 'commands up to date' }))
  })

  it('does not sync when there is no running config', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'Success', summary: 'stored only', running: null })),
      (client) => client.ApplicationCommandsSync({ environment: 'staging', apply: true, reason }),
    )
    expect(result.failure).toMatchObject({ _tag: 'ControlDependencyUnavailable', dependency: 'runtime-config' })
    expect(fetchMock()).toHaveBeenCalledTimes(1)
    expect(firstCall().url).toBe(`${baseUrl}${adminRoutes.configGet.path}`)
  })

  it('preserves authorization failures during the sync config preflight', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'ControlAuthorizationRejected', message: 'invalid token' }, 401)),
      (client) => client.ApplicationCommandsSync({ environment: 'staging', apply: true, reason }),
    )
    expect(result.failure).toMatchObject({ _tag: 'ControlAuthorizationRejected', message: 'invalid token' })
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed running config instead of sending an unguarded sync', async () => {
    const result = await runWithClient(
      () => Promise.resolve(jsonResponse({ _tag: 'Success', summary: 'config', running: { summary: {} } })),
      (client) => client.ApplicationCommandsSync({ environment: 'staging', apply: true, reason }),
    )
    expect(result.failure).toMatchObject({ _tag: 'InvalidControlInput', message: 'Malformed admin config response' })
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it('maps a decodable 401 body to ControlAuthorizationRejected', async () => {
    const result = await runWithClient(
      () =>
        Promise.resolve(jsonResponse({ _tag: 'ControlAuthorizationRejected', message: 'bearer token mismatch' }, 401)),
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
      () =>
        Promise.resolve(
          jsonResponse({ _tag: 'InvalidControlInput', message: 'payload failed schema validation' }, 422),
        ),
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
    const result = await runWithClient(
      () => Promise.reject(new TypeError('fetch failed')),
      (client) => client.RuntimeStatus({}),
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
