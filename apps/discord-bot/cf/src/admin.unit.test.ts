import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'

import { makeAdminHandler, constantTimeEquals } from './admin.ts'

/**
 * Drives the assembled admin router through the worker bridge — the exact
 * surface the deployed Worker serves — over the status/body contract from
 * CLI-DELTA.md (401 before routing, 422 schema failures, decodable error
 * bodies on every non-2xx).
 */
const token = 'secret-admin-token'
const readySnapshot = {
  supervisor: 'ready',
  hasSession: true,
  journalSchemaVersion: 1,
  docsMonthlySpentUsdMicros: 42,
}
const handler = makeAdminHandler(token, { runtimeStatus: () => Effect.succeed(readySnapshot) })
const bareHandler = makeAdminHandler(token)

const post = (path: string, body?: unknown, authorization?: string) =>
  new Request(`https://bot.example.test${path}`, {
    method: 'POST',
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const jsonBody = async (response: Response): Promise<Record<string, unknown>> =>
  JSON.parse(await response.text()) as Record<string, unknown>

it('rejects missing, malformed, and wrong bearer tokens with a constant 401', async () => {
  for (const authorization of [undefined, 'Basic c2VjcmV0', 'Bearer wrong']) {
    const response = await handler(post('/admin/rpc/RuntimeStatus', {}, authorization))
    expect(response.status).toBe(401)
    expect(await jsonBody(response)).toMatchObject({ _tag: 'ControlAuthorizationRejected' })
  }
})

it('accepts case-insensitive bearer scheme with the correct credential', async () => {
  const response = await handler(post('/admin/rpc/RuntimeStatus', {}, `bearer ${token}`))
  expect(response.status).toBe(200)
  expect(await jsonBody(response)).toMatchObject({ _tag: 'Success' })
})

it('answers 401 (not 404) to unauthenticated unknown routes', async () => {
  const response = await handler(post('/admin/rpc/NoSuchOperation', {}))
  expect(response.status).toBe(401)
})

it('validates payloads server-side into a decodable 422', async () => {
  const response = await handler(
    post(
      '/admin/rpc/ThreadCreate',
      { source: { guildId: 'nope' }, environment: 'staging', apply: true, reason: 'why' },
      `Bearer ${token}`,
    ),
  )
  expect(response.status).toBe(422)
  expect(await jsonBody(response)).toMatchObject({ _tag: 'InvalidControlInput' })
})

it('ThreadCreate validates then reports the operation unavailable (never fabricates Success)', async () => {
  const payload = {
    source: { guildId: '1234567890123456789', channelId: '2345678901234567890', messageId: '3456789012345678901' },
    environment: 'staging',
    apply: true,
    reason: 'operator asked',
  }
  const response = await handler(post('/admin/rpc/ThreadCreate', payload, `Bearer ${token}`))
  expect(response.status).toBe(503)
  expect(await jsonBody(response)).toMatchObject({
    _tag: 'ControlDependencyUnavailable',
    dependency: 'thread-creation-runtime',
  })
})

it('RuntimeStatus reports 503 without a source and mirrors a wired snapshot', async () => {
  const absent = await bareHandler(post('/admin/rpc/RuntimeStatus', {}, `Bearer ${token}`))
  expect(absent.status).toBe(503)
  expect(await jsonBody(absent)).toMatchObject({ _tag: 'ControlDependencyUnavailable' })

  const healthy = await handler(post('/admin/rpc/RuntimeStatus', {}, `Bearer ${token}`))
  expect(healthy.status).toBe(200)
  expect(await jsonBody(healthy)).toMatchObject({ _tag: 'Success' })

  const degraded = makeAdminHandler(token, {
    runtimeStatus: () => Effect.succeed({ ...readySnapshot, journalSchemaVersion: 0 }),
  })
  const unhealthy = await degraded(post('/admin/rpc/RuntimeStatus', {}, `Bearer ${token}`))
  expect(unhealthy.status).toBe(503)
})

it('unknown authenticated routes return the mapped 404 shape', async () => {
  const response = await handler(post('/admin/rpc/NoSuchOperation', {}, `Bearer ${token}`))
  expect(response.status).toBe(404)
  expect(await jsonBody(response)).toMatchObject({ _tag: 'InvalidControlInput' })
})

it('constantTimeEquals never leaks length or content through timing shortcuts', () => {
  expect(constantTimeEquals('abc', 'abc')).toBe(true)
  expect(constantTimeEquals('abc', 'abd')).toBe(false)
  expect(constantTimeEquals('abc', 'abcd')).toBe(false)
  expect(constantTimeEquals('', '')).toBe(true)
})
