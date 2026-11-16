import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const hour = 60 * 60 * 1000
export const limits = { production: 500, account: 1000 }

export const completedWindow = (now = Date.now()) => {
  const end = Math.floor(now / hour) * hour - hour
  return { start: new Date(end - 24 * hour).toISOString(), end: new Date(end).toISOString() }
}

export const readConfig = (env) => {
  const token = env.CLOUDFLARE_API_TOKEN?.trim()
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const namespace = env.CF_BOT_STATE_NAMESPACE_ID?.trim()
  if (!token || !/^[a-f0-9]{32}$/.test(account ?? '') || !/^[a-f0-9]{32}$/.test(namespace ?? '')) {
    throw new Error('Cloudflare token, account ID and production namespace ID must be configured')
  }
  const productionLimit = Number(env.CF_PRODUCTION_DURATION_LIMIT ?? limits.production)
  if (!Number.isFinite(productionLimit) || productionLimit <= 0 || productionLimit > limits.production) {
    throw new Error('Production duration threshold must be positive and at most 500 GB-s')
  }
  return { token, account, namespace, productionLimit }
}

export const assessUsage = (payload, productionLimit = limits.production) => {
  const accounts = payload?.data?.viewer?.accounts
  if (
    (payload?.errors != null && (!Array.isArray(payload.errors) || payload.errors.length > 0)) ||
    !Array.isArray(accounts) ||
    accounts.length !== 1
  ) {
    throw new Error('Cloudflare analytics returned errors or no unique account')
  }
  const duration = (name) => {
    const groups = accounts[0]?.[name]
    const value = groups?.[0]?.sum?.duration
    if (
      !Array.isArray(groups) ||
      groups.length !== 1 ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      throw new Error(`Cloudflare analytics is missing a valid ${name} duration sample`)
    }
    return value
  }
  const production = duration('production')
  const account = duration('account')
  if (production > account + 0.01) throw new Error('Cloudflare account duration is smaller than production duration')
  return { production, account, healthy: production <= productionLimit && account <= limits.account }
}

const run = async () => {
  const config = readConfig(process.env)
  const window = completedWindow()
  const period = `datetime_geq: "${window.start}", datetime_lt: "${window.end}"`
  const query = `query { viewer { accounts(filter: {accountTag: "${config.account}"}) {
    production: durableObjectsPeriodicGroups(limit: 1, filter: {namespaceId: "${config.namespace}", ${period}}) { sum { duration } }
    account: durableObjectsPeriodicGroups(limit: 1, filter: {${period}}) { sum { duration } }
  } } }`
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Cloudflare analytics returned HTTP ${response.status}`)
  const usage = assessUsage(await response.json(), config.productionLimit)
  const summary = [
    `Cloudflare spend guard ${usage.healthy ? 'PASS' : 'FAIL'}`,
    '',
    `Completed 24-hour window ${window.start} to ${window.end}. Includes a one-hour reporting buffer.`,
    '',
    '| Durable Object duration | GB-s | Alert threshold |',
    '| --- | ---: | ---: |',
    `| Production Discord | ${usage.production.toFixed(2)} | ${config.productionLimit} |`,
    `| Entire account | ${usage.account.toFixed(2)} | ${limits.account} |`,
    '',
    'This checks duration usage before the monthly allowance is exhausted. Invoice charges and Worker CPU are separate meters.',
    '',
  ].join('\n')
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (!usage.healthy) throw new Error('Cloudflare Durable Object duration exceeded the regression threshold')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Cloudflare spend check failed')
    process.exitCode = 1
  })
}
