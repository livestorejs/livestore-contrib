import { describe, expect, it } from 'vitest'

import { controlStagingGateway } from './staging-gateway.ts'

const env = {
  STAGE: 'staging',
  CF_WORKER_URL: 'https://staging.example.test',
  ADMIN_TOKEN: 'test-token',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2',
}

describe('staging gateway deployment lease', () => {
  it('retries ambiguous activation using the same owner and parks only that attempt', async () => {
    const requests: Array<{ path: string; body: unknown }> = []
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      requests.push({ path, body: JSON.parse(String(init?.body)) })
      expect(init?.redirect).toBe('error')
      if (requests.length === 1) throw new Error('lost response')
      return Response.json(
        path.endsWith('/activate')
          ? { state: 'active', owner: 'github-123-2', expiresAt: Date.now() + 1000 }
          : { state: 'parked' },
      )
    }
    await controlStagingGateway('activate', env, fetcher, async () => {})
    await controlStagingGateway('park', env, fetcher)
    expect(requests).toEqual([
      { path: '/admin/gateway/activate', body: { owner: 'github-123-2', ttlSeconds: 1800 } },
      { path: '/admin/gateway/activate', body: { owner: 'github-123-2', ttlSeconds: 1800 } },
      { path: '/admin/gateway/park', body: { owner: 'github-123-2' } },
    ])
  })

  it('fails immediately if another owner holds the staging gateway', async () => {
    await expect(
      controlStagingGateway(
        'activate',
        env,
        async () => new Response(null, { status: 409 }),
        async () => {
          throw new Error('unexpected retry')
        },
      ),
    ).rejects.toThrow('HTTP 409')
  })

  it('rejects another owner in a successful activation response', async () => {
    await expect(
      controlStagingGateway('activate', env, async () =>
        Response.json({ state: 'active', owner: 'github-123-1', expiresAt: Date.now() + 1000 }),
      ),
    ).rejects.toThrow('Invalid staging gateway activate response')
  })
})
