import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

type GatewayAction = 'activate' | 'park'

/** Own the staging gateway for one deployment attempt. Reusing the owner never extends the lease. */
export const controlStagingGateway = async (
  action: GatewayAction,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
  delay: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<void> => {
  const { STAGE, CF_WORKER_URL, ADMIN_TOKEN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = env
  if (STAGE !== 'staging') throw new Error('Gateway lifecycle is staging-only')
  if (CF_WORKER_URL === undefined || CF_WORKER_URL === '' || ADMIN_TOKEN === undefined || ADMIN_TOKEN === '')
    throw new Error('Staging Worker URL and admin token are required')
  const owner =
    env['STAGING_GATEWAY_OWNER'] ??
    (GITHUB_RUN_ID !== undefined &&
    GITHUB_RUN_ID !== '' &&
    GITHUB_RUN_ATTEMPT !== undefined &&
    GITHUB_RUN_ATTEMPT !== ''
      ? `github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`
      : undefined)
  if (owner === undefined || owner === '') throw new Error('STAGING_GATEWAY_OWNER or GitHub run identity is required')
  const worker = new URL(CF_WORKER_URL)
  if (
    worker.protocol !== 'https:' ||
    worker.username !== '' ||
    worker.password !== '' ||
    worker.search !== '' ||
    worker.hash !== ''
  ) {
    throw new Error('CF_WORKER_URL must be an HTTPS Worker URL without credentials or query parameters')
  }
  const url = new URL(`/admin/gateway/${action}`, worker)
  const ttlSeconds = Number(env['STAGING_GATEWAY_TTL_SECONDS'] ?? '1800')
  if (action === 'activate' && (Number.isInteger(ttlSeconds) === false || ttlSeconds < 1)) {
    throw new Error('STAGING_GATEWAY_TTL_SECONDS must be a positive integer')
  }
  const body = JSON.stringify(action === 'activate' ? { owner, ttlSeconds } : { owner })
  const waitSeconds = action === 'activate' ? 360 : 90
  const deadline = Date.now() + waitSeconds * 1000
  do {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    if (response?.status === 200) {
      const result: unknown = await response.json().catch(() => undefined)
      if (
        typeof result === 'object' &&
        result !== null &&
        'state' in result &&
        (action === 'park'
          ? result.state === 'parked'
          : result.state === 'active' &&
            'owner' in result &&
            result.owner === owner &&
            'expiresAt' in result &&
            typeof result.expiresAt === 'number' &&
            result.expiresAt > Date.now()) === true
      ) {
        console.log(`Staging gateway ${action === 'activate' ? 'activated' : 'parked'}`)
        return
      }
      throw new Error(`Invalid staging gateway ${action} response`)
    }
    // A newly deployed route may briefly return 404 while the prior version drains.
    // A failed transport can hide an applied mutation, so retry with the same owner.
    if (response !== undefined && response.status < 500 && !(action === 'activate' && response.status === 404)) {
      throw new Error(`Staging gateway ${action} failed (HTTP ${response.status})`)
    }
    await delay(5000)
  } while (Date.now() < deadline)
  throw new Error(`Staging gateway ${action} did not confirm within ${waitSeconds} seconds`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2]
  if (action !== 'activate' && action !== 'park') throw new Error('Usage: staging-gateway.ts activate|park')
  await controlStagingGateway(action)
}
