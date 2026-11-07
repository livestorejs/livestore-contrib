import * as Schema from 'effect/Schema'

import { RetiredHistoricalApplicationId } from '../../src/application-commands/model.ts'
import { admitRemoteIdentity, canonicalStagingApplicationId, type CloudflareDeploymentIdentity } from './release.ts'

const WorkerSettingsBinding = Schema.Struct({
  type: Schema.String,
  name: Schema.optional(Schema.String),
  class_name: Schema.optional(Schema.String),
  namespace_id: Schema.optional(Schema.String),
})

const WorkerSettingsEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Struct({ bindings: Schema.Array(WorkerSettingsBinding) }),
})

/** Decode Cloudflare's live script settings into the identity deploy must preserve. */
export const parseLiveDeploymentIdentity = (payload: unknown, workerName: string): CloudflareDeploymentIdentity => {
  const envelope = Schema.decodeUnknownSync(WorkerSettingsEnvelope)(payload)
  if (envelope.success === false) throw new Error('Cloudflare Worker settings request was unsuccessful')

  const botState = envelope.result.bindings.find(
    (binding) =>
      binding.type === 'durable_object_namespace' && (binding.class_name === 'BotState' || binding.name === 'BotState'),
  )
  if (botState?.namespace_id === undefined || botState.namespace_id === '') {
    throw new Error(`live Worker ${workerName} has no BotState Durable Object namespace binding`)
  }
  return { workerName, botStateNamespaceId: botState.namespace_id }
}

export const fetchLiveDeploymentIdentity = async (options: {
  readonly accountId: string
  readonly apiToken: string
  readonly workerName: string
  readonly fetchImpl?: typeof fetch
}): Promise<CloudflareDeploymentIdentity> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(options.workerName)}/settings`,
  )
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${options.apiToken}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.ok === false) {
    throw new Error(`Cloudflare Worker settings request failed with HTTP ${response.status}`)
  }
  return parseLiveDeploymentIdentity(await response.json(), options.workerName)
}

const requireEnvironment = (name: string): string => {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') throw new Error(`missing required environment variable ${name}`)
  return value
}

export const preflightRemoteIdentity = async (input: {
  readonly stage: string
  readonly allowInitialCreate: boolean
  readonly requested: { readonly workerName: string; readonly botStateNamespaceId?: string }
  readonly accountId: string
  readonly apiToken: string
  readonly fetchImpl?: typeof fetch
}): Promise<CloudflareDeploymentIdentity | undefined> => {
  admitRemoteIdentity(input.stage, input.requested, input.allowInitialCreate)
  const fetchImpl = input.fetchImpl ?? fetch
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.requested.workerName)}/settings`
  if (input.allowInitialCreate === true) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${input.apiToken}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status !== 404)
      throw new Error(`initial create requires absent production Worker (HTTP ${response.status})`)
    return undefined
  }
  const observed = await fetchLiveDeploymentIdentity({
    accountId: input.accountId,
    apiToken: input.apiToken,
    workerName: input.requested.workerName,
    fetchImpl,
  })
  admitRemoteIdentity(input.stage, observed, false)
  return observed
}

const run = async (): Promise<void> => {
  if (process.argv.includes('--embedded-only') === true && process.env['CF_GATEWAY_TRANSPORT'] === 'worker') {
    throw new Error('Worker Gateway transport requires cf/scripts/remote.sh plan|deploy --stage staging|production')
  }
  const stage = process.env['CF_DEPLOY_STAGE'] ?? 'staging'
  if (stage === 'production') {
    const applicationId = requireEnvironment('DISCORD_APPLICATION_ID')
    if (
      /^\d{17,20}$/.test(applicationId) === false ||
      applicationId === RetiredHistoricalApplicationId ||
      applicationId === canonicalStagingApplicationId
    ) {
      throw new Error('production requires a distinct, valid DISCORD_APPLICATION_ID')
    }
  }
  const allowInitialCreate = process.env['CF_ALLOW_INITIAL_CREATE'] === '1'
  const observedIdentity = await preflightRemoteIdentity({
    stage,
    allowInitialCreate,
    requested: {
      workerName: requireEnvironment('CF_WORKER_NAME'),
      botStateNamespaceId: process.env['CF_BOT_STATE_NAMESPACE_ID']?.trim() || undefined,
    },
    accountId: requireEnvironment('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requireEnvironment('CLOUDFLARE_API_TOKEN'),
  })
  process.stdout.write(
    observedIdentity === undefined
      ? 'Cloudflare initial production create preflight passed · Worker absent\n'
      : `Cloudflare preflight passed · worker=${observedIdentity.workerName} · BotState=${observedIdentity.botStateNamespaceId}\n`,
  )
}

if (import.meta.main) {
  await run().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(`CRITICAL Cloudflare deployment preflight failed\n\n  ${message}`)
    process.exitCode = 1
  })
}
