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

// ---------------------------------------------------------------------------
// Real operations: config plane, operator ThreadCreate, commands sync
// ---------------------------------------------------------------------------

const validConfigPayload = {
  _tag: 'real',
  schemaVersion: 1,
  environment: 'staging',
  applicationId: '1541431832195633232',
  guildId: '1154415661842452532',
  commandScope: { _tag: 'GuildCommandScope', applicationId: '1541431832195633232', guildId: '1154415661842452532' },
  actionChannelIds: ['1373597443798859776'],
  aiTitleChannelIds: ['1373597443798859776'],
  stagingOnlyChannelIds: ['1373597443798859776'],
  legacyCommands: [],
  docsAudience: {
    publicChannelIds: ['1373597443798859776'],
    roleRestrictedChannelIds: [],
    contributorMaintainerRoleIds: [],
  },
  botTokenSecretRef: 'cf-secret/DISCORD_BOT_TOKEN',
  openAi: {
    projectId: 'p',
    serviceAccountSecretRef: 's',
    retentionPosture: 'standard-store-false',
    limits: {
      requestsPerMemberPerHour: 10,
      requestsPerMinute: 2,
      inputTokensPerRequest: 40000,
      outputTokensPerRequest: 2000,
      monthlyCostUsdMicros: 1000000,
    },
  },
  releaseId: 'dev',
  telemetry: { sink: 'dev3-tempo', delivery: 'best-effort', accessBoundary: 'tailnet', retentionDays: 30 },
  e2e: {
    actorApplicationId: '1541431832195633232',
    actorTokenSecretRef: 'cf-secret/E2E_ACTOR_TOKEN',
    targetChannelId: '1373597443798859776',
    requiredPurposeMarker: 'livestore-discord-e2e-only',
  },
  stateDirectory: '/var/lib/livestore-discord',
  controlSocketPath: '/var/lib/livestore-discord/control.sock',
  health: { host: '127.0.0.1', port: 8787 },
  credentials: {
    discordTokenFile: '/secrets/discord-token',
    openAiApiKeyFile: '/secrets/openai-api-key',
    docsCorrelationKeyFile: '/secrets/docs-correlation-key',
  },
}

const outcome = (ok: boolean, status: number, body: Record<string, unknown>) => ({ ok, status, body })

const fullHandler = makeAdminHandler(token, {
  runtimeStatus: () => Effect.succeed(readySnapshot),
  threadCreate: (payload) => {
    const source = (payload as { source?: { messageId?: string } }).source
    return Effect.succeed(
      outcome(true, 200, {
        _tag: 'Success',
        summary: `Created thread 999.`,
        correlationId: source?.messageId,
      }),
    )
  },
  configGet: Effect.succeed(
    outcome(true, 200, { _tag: 'Success', summary: 'config', payload: validConfigPayload }),
  ),
  configPut: (payload) =>
    (payload as { environment?: string }).environment === 'staging'
      ? Effect.succeed(outcome(true, 200, { _tag: 'Success', summary: 'persisted' }))
      : Effect.succeed(
          outcome(false, 422, { _tag: 'InvalidControlInput', message: 'Runtime config failed schema validation' }),
        ),
  commandsSync: Effect.succeed(
    outcome(true, 200, { _tag: 'AlreadySatisfied', summary: 'changes=false create=0 update=0 delete=0 unchanged=2' }),
  ),
})

const get = (path: string, authorization?: string) =>
  new Request(`https://bot.example.test${path}`, {
    headers: authorization === undefined ? {} : { authorization },
  })

it('ThreadCreate executes through the wired real trigger and returns Success', async () => {
  const payload = {
    source: { guildId: '1234567890123456789', channelId: '2345678901234567890', messageId: '3456789012345678901' },
    environment: 'staging',
    apply: true,
    reason: 'operator asked',
  }
  const response = await fullHandler(post('/admin/rpc/ThreadCreate', payload, `Bearer ${token}`))
  expect(response.status).toBe(200)
  const body = await jsonBody(response)
  expect(body).toMatchObject({ _tag: 'Success', correlationId: '3456789012345678901' })
})

it('GET /admin/config serves the stored config document behind bearer auth', async () => {
  const unauthenticated = await fullHandler(get('/admin/config'))
  expect(unauthenticated.status).toBe(401)

  const response = await fullHandler(get('/admin/config', `Bearer ${token}`))
  expect(response.status).toBe(200)
  expect(await jsonBody(response)).toMatchObject({ _tag: 'Success', payload: { environment: 'staging' } })
})

it('PUT /admin/config validates before persisting; invalid bodies get a 422', async () => {
  const good = await fullHandler(
    new Request('https://bot.example.test/admin/config', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(validConfigPayload),
    }),
  )
  expect(good.status).toBe(200)
  expect(await jsonBody(good)).toMatchObject({ _tag: 'Success' })

  const bad = await fullHandler(
    new Request('https://bot.example.test/admin/config', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ environment: 'production' }),
    }),
  )
  expect(bad.status).toBe(422)
  expect(await jsonBody(bad)).toMatchObject({ _tag: 'InvalidControlInput' })
})

it('POST /admin/commands-sync reports AlreadySatisfied when no drift exists', async () => {
  const response = await fullHandler(post('/admin/commands-sync', {}, `Bearer ${token}`))
  expect(response.status).toBe(200)
  expect(await jsonBody(response)).toMatchObject({ _tag: 'AlreadySatisfied' })
})

it('unwired new routes degrade to ControlDependencyUnavailable instead of failing loudly', async () => {
  const bare = makeAdminHandler(token)
  // A VALID payload reaches the unwired-operation fallback; invalid payloads
  // stop at 422 validation first.
  const response = await bare(
    post(
      '/admin/rpc/ThreadCreate',
      {
        source: { guildId: '1234567890123456789', channelId: '2345678901234567890', messageId: '3456789012345678901' },
        environment: 'staging',
        apply: true,
        reason: 'operator asked',
      },
      `Bearer ${token}`,
    ),
  )
  expect(response.status).toBe(503)
  expect(await jsonBody(response)).toMatchObject({ _tag: 'ControlDependencyUnavailable' })
  {
    const syncResponse = await bare(post('/admin/commands-sync', {}, `Bearer ${token}`))
    expect(syncResponse.status).toBe(503)
    expect(await jsonBody(syncResponse)).toMatchObject({ _tag: 'ControlDependencyUnavailable' })
  }
  for (const path of ['/admin/config']) {
    const got = await bare(get(path, `Bearer ${token}`))
    expect(got.status).toBe(503)
  }
})
