import * as Config from 'effect/Config'
import * as Schema from 'effect/Schema'

const ReleaseId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
  identifier: 'DiscordBot.ReleaseId',
})

/**
 * Remote deploys must carry immutable build identity. Credential-free local
 * workerd runs deliberately use `dev` when no release was supplied.
 */
export const releaseIdConfig = (local: boolean) => {
  const configured = Config.schema(ReleaseId, 'RELEASE_ID')
  return local === true ? configured.pipe(Config.withDefault('dev')) : configured
}

/** Reads the resolved plain-text Worker binding and fails closed if it drifted. */
export const readReleaseId = (env: Record<string, unknown>): string => {
  const value = env['RELEASE_ID']
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('RELEASE_ID Worker binding is unavailable or empty')
  }
  return value
}

/** Cloudflare's version_metadata binding is absent only in local emulation. */
export const readWorkerVersionId = (env: Record<string, unknown>): string | undefined => {
  const metadata = env['CF_VERSION_METADATA']
  if (typeof metadata !== 'object' || metadata === null) return undefined
  if ('id' in metadata === false) return undefined
  const id = metadata.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export interface CloudflareDeploymentIdentity {
  readonly workerName: string
  readonly botStateNamespaceId: string
}

export const canonicalStagingIdentity = {
  workerName: 'discordbot-discordbot-staging-fzb2yrs5oh7y4ttr',
  botStateNamespaceId: '9fca2fc956e8417c878f89fac50ea207',
} as const satisfies CloudflareDeploymentIdentity

/** Returns the first identity drift that must abort remote adoption/deploy. */
export const deploymentIdentityMismatch = (
  expected: CloudflareDeploymentIdentity,
  observed: CloudflareDeploymentIdentity,
): string | undefined => {
  if (observed.workerName !== expected.workerName) {
    return `remote Worker identity mismatch: expected ${expected.workerName}, observed ${observed.workerName}`
  }
  if (observed.botStateNamespaceId !== expected.botStateNamespaceId) {
    return `remote BotState namespace mismatch: expected ${expected.botStateNamespaceId}, observed ${observed.botStateNamespaceId}`
  }
  return undefined
}
