import { pathToFileURL } from 'node:url'

import { makeDefaultRuntimeConfig } from '../src/runtime-config.ts'

type Stage = 'staging' | 'production'
type Fetcher = typeof fetch

/** Reconcile only the application-command scope belonging to the deployed stage. */
export const syncDeployedCommands = async (
  stage: Stage,
  env: Record<string, string | undefined> = process.env,
  fetcher: Fetcher = fetch,
  log: (message: string) => void = console.log,
): Promise<void> => {
  const token = env['ADMIN_TOKEN']
  const workerUrl = env['CF_WORKER_URL']
  if (token === undefined || token === '' || workerUrl === undefined || workerUrl === '') {
    throw new Error('ADMIN_TOKEN and CF_WORKER_URL are required')
  }
  const url = new URL('/admin/commands-sync', workerUrl)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('CF_WORKER_URL must be an HTTPS Worker URL without credentials or query parameters')
  }
  const config = makeDefaultRuntimeConfig('ci', stage, env['DISCORD_APPLICATION_ID'])
  const scope = config.commandScope
  if (scope._tag !== 'GuildCommandScope') throw new Error('Expected a guild command scope')

  const request = async (apply: boolean) => {
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          environment: stage,
          reason: 'CI deploy command convergence',
          apply,
          expectedApplicationId: scope.applicationId,
          expectedGuildId: scope.guildId,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error(`Command sync ${apply === true ? 'apply' : 'plan'} request failed`)
    }
    if (response.ok === false) {
      throw new Error(`Command sync ${apply === true ? 'apply' : 'plan'} failed (HTTP ${response.status})`)
    }
    let result: unknown
    try {
      result = await response.json()
    } catch {
      throw new Error('Command sync response is not JSON')
    }
    if (typeof result !== 'object' || result === null || !('_tag' in result) || !('summary' in result)) {
      throw new Error('Command sync response is malformed')
    }
    const expectedTags = apply === true ? ['Success', 'AlreadySatisfied'] : ['Planned']
    if (
      typeof result._tag !== 'string' ||
      expectedTags.includes(result._tag) === false ||
      typeof result.summary !== 'string'
    ) {
      throw new Error('Command sync response has an unexpected outcome')
    }
    const counts = /^changes=(true|false) create=(\d+) update=(\d+) delete=(\d+) unchanged=(\d+)$/.exec(result.summary)
    if (counts === null) throw new Error('Command sync response has an invalid summary')
    const changed = counts[1] === 'true'
    const changes = Number(counts[2]) + Number(counts[3]) + Number(counts[4])
    if (changed !== changes > 0) throw new Error('Command sync response has inconsistent counts')
    return { summary: result.summary, changed, unchanged: Number(counts[5]) }
  }

  log(`Command sync plan: ${(await request(false)).summary}`)
  log(`Command sync apply: ${(await request(true)).summary}`)
  const verification = await request(false)
  if (verification.changed === true || verification.unchanged === 0) {
    throw new Error('Command sync verification failed: expected registered commands without drift')
  }
  log(`Command sync verified: ${verification.summary}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stage = process.argv[2]
  if (stage !== 'staging' && stage !== 'production') throw new Error('Usage: commands-sync.ts staging|production')
  await syncDeployedCommands(stage)
}
