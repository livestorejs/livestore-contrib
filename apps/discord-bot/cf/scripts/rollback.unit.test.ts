import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { canonicalProductionIdentity, canonicalStagingIdentity } from '../src/release.ts'
import { parseRollbackArgs, rollback, type RollbackHttpClient } from './rollback.ts'

const current = '11111111-1111-4111-8111-111111111111'
const previous = '22222222-2222-4222-8222-222222222222'
const deployment = '33333333-3333-4333-8333-333333333333'
const config = {
  accountId: '0e7b96be3cd78f3fc7a134ef6fed4c39',
  workerName: canonicalStagingIdentity.workerName,
  apiToken: 'private-test-token',
}
const productionConfig = {
  ...config,
  stage: 'production' as const,
  workerName: canonicalProductionIdentity.workerName,
}
const response = (result: unknown) => Response.json({ success: true, result })
const version = (id: string, releaseId: string, migrationTag = 'v1') => ({
  id,
  resources: {
    bindings: [
      { type: 'plain_text', name: 'RELEASE_ID', text: releaseId },
      { type: 'secret_text', name: 'ADMIN_TOKEN', text: 'never-print' },
    ],
    script_runtime: { migration_tag: migrationTag },
  },
})
const mockClient = (
  options: { readonly currentTag?: string; readonly previousTag?: string; readonly currentPercent?: number } = {},
) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client: RollbackHttpClient = {
    request: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/versions?deployable=true') === true)
        return response({
          items: [
            { id: current, number: 2 },
            { id: previous, number: 1 },
          ],
        })
      if (url.endsWith('/deployments?per_page=1') === true)
        return response({
          deployments: [
            {
              id: deployment,
              created_on: '2026-09-26T00:00:00Z',
              strategy: 'percentage',
              versions: [{ version_id: current, percentage: options.currentPercent ?? 100 }],
            },
          ],
        })
      if (url.endsWith(`/versions/${current}`) === true)
        return response(version(current, 'release-N', options.currentTag))
      if (url.endsWith(`/versions/${previous}`) === true) {
        return response({
          id: previous,
          resources: {
            bindings: {
              RELEASE_ID: { type: 'plain_text', text: 'release-N-1' },
              ADMIN_TOKEN: { type: 'secret_text', text: 'never-print' },
            },
            script_runtime: { migration_tag: options.previousTag ?? 'v1' },
          },
        })
      }
      if (url.endsWith('/deployments') === true && init.method === 'POST')
        return response({
          id: deployment,
          created_on: '2026-09-26T01:00:00Z',
          strategy: 'percentage',
          versions: [{ version_id: previous, percentage: 100 }],
        })
      throw new Error('unexpected HTTP request')
    },
  }
  return { client, calls }
}

describe('cf:rollback argument parsing and approval', () => {
  it('accepts read-only list without deploy approval', () => {
    expect(parseRollbackArgs(['list'], undefined)).toEqual({ action: 'list' })
  })

  it('rejects missing approval, --yes, assertion, malformed version, and extra flags', () => {
    expect(() =>
      parseRollbackArgs(['select', '--version', previous, '--yes', '--assert-do-compatible'], undefined),
    ).toThrow()
    expect(() => parseRollbackArgs(['select', '--version', previous, '--assert-do-compatible'], 'deploy')).toThrow()
    expect(() => parseRollbackArgs(['select', '--version', previous, '--yes'], 'deploy')).toThrow()
    expect(() =>
      parseRollbackArgs(['select', '--version', 'bad', '--yes', '--assert-do-compatible'], 'deploy'),
    ).toThrow()
    expect(() => parseRollbackArgs(['list', '--yes'], 'deploy')).toThrow()
  })
})

describe('cf:rollback API selection', () => {
  it('reports the fully deployed release without exposing bindings or issuing writes', async () => {
    const { client, calls } = mockClient()
    const result = await Effect.runPromise(rollback({ action: 'current' }, productionConfig, client))
    expect(result).toEqual({ currentVersionId: current, releaseId: 'release-N' })
    expect(calls.every(({ init }) => init.method === undefined)).toBe(true)
  })

  it('lists deployable versions with release identities but does not expose secret bindings or issue writes', async () => {
    const { client, calls } = mockClient()
    const result = await Effect.runPromise(rollback({ action: 'list' }, config, client))
    expect(result.environment).toBe('staging')
    expect(result).toMatchObject({
      currentVersionId: current,
      versions: [
        { versionId: current, releaseId: 'release-N' },
        { versionId: previous, releaseId: 'release-N-1' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('never-print')
    expect(calls.every(({ init }) => init.method === undefined)).toBe(true)
  })

  it('lists production deployable versions with a production audit stage', async () => {
    const { client, calls } = mockClient()
    const result = await Effect.runPromise(rollback({ action: 'list' }, productionConfig, client))
    expect(result).toMatchObject({
      environment: 'production',
      currentVersionId: current,
      versions: [
        { versionId: current, releaseId: 'release-N' },
        { versionId: previous, releaseId: 'release-N-1' },
      ],
    })
    expect(
      calls.every(
        ({ url, init }) => url.includes(`/scripts/${productionConfig.workerName}/`) && init.method === undefined,
      ),
    ).toBe(true)
  })

  it('selects a production version with a production annotation and receipt', async () => {
    const { client, calls } = mockClient()
    const result = await Effect.runPromise(
      rollback({ action: 'select', version: previous, assertDoCompatible: true }, productionConfig, client),
    )
    const post = calls.find(({ init }) => init.method === 'POST')
    expect(post?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${productionConfig.accountId}/workers/scripts/${productionConfig.workerName}/deployments`,
    )
    const postBody = post?.init.body
    if (typeof postBody !== 'string') throw new Error('expected JSON rollback request body')
    expect(JSON.parse(postBody)).toEqual({
      strategy: 'percentage',
      versions: [{ version_id: previous, percentage: 100 }],
      annotations: { 'workers/message': `Discord bot production select existing version ${previous}` },
    })
    expect(result).toMatchObject({
      environment: 'production',
      fromVersionId: current,
      toVersionId: previous,
      fromReleaseId: 'release-N',
      toReleaseId: 'release-N-1',
      outcome: 'applied',
      readiness: 'UNVERIFIED',
    })
  })

  it('POSTs only a 100% preexisting version and emits a sanitized unverified receipt', async () => {
    const { client, calls } = mockClient()
    const result = await Effect.runPromise(
      rollback({ action: 'select', version: previous, assertDoCompatible: true }, config, client),
    )
    const post = calls.find(({ init }) => init.method === 'POST')
    expect(post?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts/${config.workerName}/deployments`,
    )
    const postBody = post?.init.body
    if (typeof postBody !== 'string') throw new Error('expected JSON rollback request body')
    expect(JSON.parse(postBody)).toEqual({
      strategy: 'percentage',
      versions: [{ version_id: previous, percentage: 100 }],
      annotations: { 'workers/message': `Discord bot staging select existing version ${previous}` },
    })
    expect(result).toMatchObject({
      environment: 'staging',
      fromVersionId: current,
      toVersionId: previous,
      fromReleaseId: 'release-N',
      toReleaseId: 'release-N-1',
      readiness: 'UNVERIFIED',
    })
    expect(JSON.stringify(result)).not.toContain('never-print')
    expect(JSON.stringify(result)).not.toContain(config.apiToken)
  })

  it('fails closed for split traffic, nondeployable target, migration boundary, and absent assertion', async () => {
    for (const [command, client] of [
      [{ action: 'select', version: previous, assertDoCompatible: true }, mockClient({ currentPercent: 50 })],
      [{ action: 'select', version: '44444444-4444-4444-8444-444444444444', assertDoCompatible: true }, mockClient()],
      [
        { action: 'select', version: previous, assertDoCompatible: true },
        mockClient({ currentTag: 'v2', previousTag: 'v1' }),
      ],
      [{ action: 'select', version: previous, assertDoCompatible: false }, mockClient()],
    ] as const) {
      const exit = await Effect.runPromiseExit(rollback(command, config, client.client))
      expect(exit._tag).toBe('Failure')
      expect(client.calls.some(({ init }) => init.method === 'POST')).toBe(false)
    }
  })

  it('re-reads deployments after a dispatched POST times out and recognizes an applied selection', async () => {
    const { client: base, calls } = mockClient()
    let reads = 0
    const client: RollbackHttpClient = {
      request: (url, init) => {
        if (url.endsWith('/deployments?per_page=1') === true && ++reads === 2) {
          return Promise.resolve(
            response({
              deployments: [
                {
                  id: deployment,
                  created_on: '2026-09-26T01:00:00Z',
                  strategy: 'percentage',
                  versions: [{ version_id: previous, percentage: 100 }],
                },
              ],
            }),
          )
        }
        if (url.endsWith('/deployments') === true && init.method === 'POST') {
          calls.push({ url, init })
          return Promise.reject(new Error('simulated timeout: private details'))
        }
        return base.request(url, init)
      },
    }
    const result = await Effect.runPromise(
      rollback({ action: 'select', version: previous, assertDoCompatible: true }, config, client),
    )
    expect(result).toMatchObject({ outcome: 'applied', toVersionId: previous, deploymentId: deployment })
    expect(JSON.stringify(result)).not.toContain('private details')
    expect(reads).toBe(2)
  })

  it('returns unknown after a dispatched timeout when readback is inconclusive', async () => {
    const { client: base } = mockClient()
    const client: RollbackHttpClient = {
      request: (url, init) =>
        init.method === 'POST' ? Promise.reject(new Error('private timeout')) : base.request(url, init),
    }
    const result = await Effect.runPromise(
      rollback({ action: 'select', version: previous, assertDoCompatible: true }, config, client),
    )
    expect(result).toMatchObject({ outcome: 'unknown', step: 'post', toVersionId: previous })
    expect(JSON.stringify(result)).not.toContain('private timeout')
  })

  it('re-reads after POST HTTP rejection or invalid response without leaking provider payloads', async () => {
    for (const postResponse of [
      new Response('secret provider error', { status: 503 }),
      Response.json({ success: false, errors: [{ message: 'secret provider error' }] }),
    ]) {
      const { client: base } = mockClient()
      const client: RollbackHttpClient = {
        request: (url, init) =>
          url.endsWith('/deployments') === true && init.method === 'POST'
            ? Promise.resolve(postResponse)
            : base.request(url, init),
      }
      const receipt = await Effect.runPromise(
        rollback({ action: 'select', version: previous, assertDoCompatible: true }, config, client),
      )
      expect(receipt).toMatchObject({ outcome: 'unknown', step: 'post' })
      expect(JSON.stringify(receipt)).not.toContain('secret provider error')
    }
  })

  it('reports a specific guard before POST and not-applied for pre-dispatch HTTP failures', async () => {
    const { client: base } = mockClient({ currentPercent: 50 })
    await expect(
      Effect.runPromise(rollback({ action: 'select', version: previous, assertDoCompatible: true }, config, base)),
    ).rejects.toThrow(/guard:binary-deployment/)
    const failed: RollbackHttpClient = {
      request: (url, init) =>
        url.endsWith('/versions?deployable=true') === true
          ? Promise.resolve(new Response('', { status: 403 }))
          : base.request(url, init),
    }
    await expect(
      Effect.runPromise(rollback({ action: 'select', version: previous, assertDoCompatible: true }, config, failed)),
    ).rejects.toThrow(/outcome=not-applied.*step=versions.*HTTP 403/)
  })
  it('rejects a production rollback whose BotState namespace differs from the pinned one', async () => {
    const { client, calls } = mockClient()
    await expect(
      Effect.runPromise(
        rollback(
          { action: 'list' },
          {
            ...config,
            stage: 'production',
            workerName: 'discordbot-discordbot-production',
            botStateNamespaceId: '00000000000000000000000000000000',
          },
          client,
        ),
      ),
    ).rejects.toThrow(/guard:stage-identity/)
    expect(calls).toEqual([])
  })
})
