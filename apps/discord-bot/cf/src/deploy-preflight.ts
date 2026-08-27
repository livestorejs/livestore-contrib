import * as Schema from 'effect/Schema'

import {
  canonicalStagingIdentity,
  deploymentIdentityMismatch,
  type CloudflareDeploymentIdentity,
} from './release.ts'

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
export const parseLiveDeploymentIdentity = (
  payload: unknown,
  workerName: string,
): CloudflareDeploymentIdentity => {
  const envelope = Schema.decodeUnknownSync(WorkerSettingsEnvelope)(payload)
  if (envelope.success === false) throw new Error('Cloudflare Worker settings request was unsuccessful')

  const botState = envelope.result.bindings.find(
    (binding) =>
      binding.type === 'durable_object_namespace' &&
      (binding.class_name === 'BotState' || binding.name === 'BotState'),
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

const run = async (): Promise<void> => {
  const requestedIdentity = {
    workerName: requireEnvironment('CF_WORKER_NAME'),
    botStateNamespaceId: requireEnvironment('CF_BOT_STATE_NAMESPACE_ID'),
  }
  const requestedMismatch = deploymentIdentityMismatch(canonicalStagingIdentity, requestedIdentity)
  if (requestedMismatch !== undefined) throw new Error(requestedMismatch)

  const observedIdentity = await fetchLiveDeploymentIdentity({
    accountId: requireEnvironment('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requireEnvironment('CLOUDFLARE_API_TOKEN'),
    workerName: requestedIdentity.workerName,
  })
  const observedMismatch = deploymentIdentityMismatch(requestedIdentity, observedIdentity)
  if (observedMismatch !== undefined) throw new Error(observedMismatch)

  process.stdout.write(
    `Cloudflare preflight passed · worker=${observedIdentity.workerName} · BotState=${observedIdentity.botStateNamespaceId}\n`,
  )
}

if (import.meta.main) {
  await run().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(`CRITICAL Cloudflare deployment preflight failed\n\n  ${message}`)
    process.exitCode = 1
  })
}
