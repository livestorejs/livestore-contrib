import { describe, expect, it } from 'vitest'

import { canonicalStagingApplicationId } from '../src/release.ts'
import { reconcileInteractionsEndpoint } from './interactions-endpoint.ts'

const origin = 'https://discordbot-discordbot-staging-fzb2yrs5oh7y4ttr.livestore.workers.dev'
const endpoint = `${origin}/discord/interactions`
const env = { DISCORD_BOT_TOKEN: 'test-token', CF_WORKER_URL: origin }

const discord = (initial: string | null, id: string = canonicalStagingApplicationId) => {
  let url = initial
  const writes: Array<string | null> = []
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'PATCH') {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request body')
      const body = JSON.parse(init.body) as { interactions_endpoint_url: string | null }
      url = body.interactions_endpoint_url
      writes.push(url)
    }
    return Response.json({ id, interactions_endpoint_url: url, verify_key: 'a'.repeat(64) })
  }
  return { writes, fetcher }
}

describe('interaction delivery operator', () => {
  it('sets and clears the canonical staging endpoint with an idempotent readback', async () => {
    const api = discord(null)
    expect((await reconcileInteractionsEndpoint('staging', 'set', env, api.fetcher)).endpoint).toBe(endpoint)
    await reconcileInteractionsEndpoint('staging', 'set', env, api.fetcher)
    expect((await reconcileInteractionsEndpoint('staging', 'clear', env, api.fetcher)).endpoint).toBeNull()
    expect(api.writes).toEqual([endpoint, null])
  })

  it('requires the canonical endpoint and matching key before Worker mode', async () => {
    const api = discord(endpoint)
    const configured = { ...env, DISCORD_INTERACTIONS_PUBLIC_KEY: 'a'.repeat(64) }
    await expect(reconcileInteractionsEndpoint('staging', 'verify', configured, api.fetcher)).resolves.toMatchObject({
      endpoint,
    })
    await expect(reconcileInteractionsEndpoint('staging', 'verify', env, api.fetcher)).rejects.toThrow('matching')
    const other = discord('https://different.example/discord/interactions')
    await expect(reconcileInteractionsEndpoint('staging', 'verify', configured, other.fetcher)).rejects.toThrow(
      'canonical signed endpoint',
    )
    expect([...api.writes, ...other.writes]).toEqual([])
  })

  it('refuses a different application, external endpoint, or wrong stage origin before mutation', async () => {
    const wrongApp = discord(null, '100000000000000001')
    await expect(reconcileInteractionsEndpoint('staging', 'set', env, wrongApp.fetcher)).rejects.toThrow('identity')
    const otherEndpoint = discord('https://different.example/endpoint')
    await expect(reconcileInteractionsEndpoint('staging', 'clear', env, otherEndpoint.fetcher)).rejects.toThrow(
      'different interaction endpoint',
    )
    await expect(
      reconcileInteractionsEndpoint(
        'staging',
        'set',
        { ...env, CF_WORKER_URL: 'https://different.example' },
        otherEndpoint.fetcher,
      ),
    ).rejects.toThrow('canonical Worker URL')
    expect([...wrongApp.writes, ...otherEndpoint.writes]).toEqual([])
    await expect(
      reconcileInteractionsEndpoint(
        'production',
        'set',
        {
          DISCORD_BOT_TOKEN: 'staging-test-token',
          DISCORD_APPLICATION_ID: canonicalStagingApplicationId,
          CF_WORKER_URL: 'https://discordbot-discordbot-production.livestore.workers.dev',
          AGENT_ACTION_APPROVAL: 'deploy',
        },
        async () => {
          throw new Error('Discord must not be called')
        },
      ),
    ).rejects.toThrow('stage-specific')
  })
})
