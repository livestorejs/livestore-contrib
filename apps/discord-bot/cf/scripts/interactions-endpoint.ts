import { pathToFileURL } from 'node:url'

import { canonicalIdentityForStage, canonicalStagingApplicationId, type RemoteStage } from '../src/release.ts'

const canonicalProductionApplicationId = '1553674978757451776'
const applicationEndpoint = 'https://discord.com/api/v10/applications/@me'
type Operation = 'current' | 'verify' | 'set' | 'clear'

/** Reconcile one app's interaction delivery without touching its registered commands. */
export const reconcileInteractionsEndpoint = async (
  stage: RemoteStage,
  operation: Operation,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) => {
  const applicationId = stage === 'staging' ? canonicalStagingApplicationId : canonicalProductionApplicationId
  const token = env['DISCORD_BOT_TOKEN']
  const workerOrigin = `https://${canonicalIdentityForStage(stage).workerName}.livestore.workers.dev`
  if (
    (stage === 'production' && env['DISCORD_APPLICATION_ID'] !== applicationId) ||
    token === undefined ||
    token === '' ||
    (operation !== 'current' && env['CF_WORKER_URL'] !== workerOrigin)
  ) {
    throw new Error('Expected a stage-specific Discord bot token, application ID, and canonical Worker URL')
  }
  if (
    stage === 'production' &&
    (operation === 'set' || operation === 'clear') &&
    env['AGENT_ACTION_APPROVAL'] !== 'deploy'
  ) {
    throw new Error('Production interaction delivery changes require AGENT_ACTION_APPROVAL=deploy')
  }

  const request = async (method: 'GET' | 'PATCH', endpoint?: string | null) => {
    const response = await fetcher(applicationEndpoint, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
        'user-agent': 'DiscordBot (https://livestore.dev, 1)',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      ...(method === 'PATCH' ? { body: JSON.stringify({ interactions_endpoint_url: endpoint }) } : {}),
    })
    if (response.ok === false) throw new Error(`Discord application ${method} failed (HTTP ${response.status})`)
    const app: unknown = await response.json()
    if (
      typeof app !== 'object' ||
      app === null ||
      !('id' in app) ||
      app.id !== applicationId ||
      !('verify_key' in app) ||
      typeof app.verify_key !== 'string' ||
      /^[0-9a-f]{64}$/i.test(app.verify_key) === false
    ) {
      throw new Error('Discord returned an unexpected application identity')
    }
    const url = 'interactions_endpoint_url' in app ? app.interactions_endpoint_url : null
    if (url !== null && typeof url !== 'string') throw new Error('Unexpected Discord interactions endpoint value')
    return { applicationId, endpoint: url, publicKey: app.verify_key }
  }

  const current = await request('GET')
  if (operation === 'current') return current
  const canonical = `${workerOrigin}/discord/interactions`
  if (operation === 'verify') {
    if (
      current.endpoint !== canonical ||
      current.publicKey.toLowerCase() !== env['DISCORD_INTERACTIONS_PUBLIC_KEY']?.toLowerCase()
    ) {
      throw new Error('Worker Gateway mode requires the canonical signed endpoint and matching verification key')
    }
    return current
  }
  if (current.endpoint !== null && current.endpoint !== canonical) {
    throw new Error('Discord already uses a different interaction endpoint')
  }
  const desired = operation === 'set' ? canonical : null
  if (current.endpoint === desired) return current
  await request('PATCH', desired)
  const verified = await request('GET')
  if (verified.endpoint !== desired) throw new Error('Discord interaction endpoint did not converge')
  return verified
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, operation] = process.argv.slice(2)
  if (
    (stage !== 'staging' && stage !== 'production') ||
    (operation !== 'current' && operation !== 'verify' && operation !== 'set' && operation !== 'clear')
  ) {
    throw new Error('Usage: interactions-endpoint.ts staging|production current|verify|set|clear')
  }
  console.log(JSON.stringify(await reconcileInteractionsEndpoint(stage, operation)))
}
