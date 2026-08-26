import { posix } from 'node:path'

import { topicSentinel, type Snowflake, type StagingTarget } from './model.ts'

export interface LiveManifest {
  readonly schemaVersion: 1
  readonly environment: 'staging'
  readonly target: StagingTarget
  readonly actorBotTokenRef: `op://${string}`
  /**
   * Present: operator lanes cross the authenticated HTTPS admin plane of a
   * Cloudflare edge deployment (`POST {endpoint}/admin/rpc/{Operation}` with
   * LIVESTORE_DISCORD_ADMIN_TOKEN) instead of the Unix control socket + CLI.
   * Mutually exclusive with botControlSocket.
   */
  readonly botAdminEndpoint?: string
  readonly botControlSocket?: string
}

export class LiveManifestError extends Error {
  override readonly name = 'LiveManifestError'
}

const snowflakePattern = /^\d{17,20}$/u

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) {
    throw new LiveManifestError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const exactKeys = (value: Record<string, unknown>, admitted: ReadonlySet<string>, label: string): void => {
  const unknown = Object.keys(value).find((key) => !admitted.has(key))
  if (unknown !== undefined) throw new LiveManifestError(`${label}.${unknown} is not admitted`)
}

const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LiveManifestError(`${label} must be a non-empty string`)
  }
  return value
}

const snowflake = (value: unknown, label: string): Snowflake => {
  const parsed = string(value, label)
  if (snowflakePattern.test(parsed) === false) throw new LiveManifestError(`${label} must be a snowflake`)
  return parsed as Snowflake
}

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value <= 0) {
    throw new LiveManifestError(`${label} must be a positive integer`)
  }
  return value
}

const httpsEndpoint = (value: unknown, label: string): string => {
  const parsed = string(value, label)
  let url: URL
  try {
    url = new URL(parsed)
  } catch {
    throw new LiveManifestError(`${label} must be an HTTPS URL`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new LiveManifestError(`${label} must be a bare HTTPS origin/path without credentials, query, or fragment`)
  }
  return parsed
}

/** Parses only non-secret configuration and enforces op:// credential indirection. */
export const parseLiveManifest = (input: unknown): LiveManifest => {
  const root = object(input, 'manifest')
  exactKeys(
    root,
    new Set([
      'schemaVersion',
      'environment',
      'target',
      'actorBotTokenRef',
      'botControlSocket',
      'botAdminEndpoint',
    ]),
    'manifest',
  )
  if (root.schemaVersion !== 1) throw new LiveManifestError('schemaVersion must be 1')
  if (root.environment !== 'staging') {
    throw new LiveManifestError('environment must be exactly staging')
  }
  const targetInput = object(root.target, 'target')
  exactKeys(
    targetInput,
    new Set([
      'guildId',
      'channelId',
      'docsChannelIds',
      'allowedChannelIds',
      'requiredTopicSentinel',
      'pollIntervalMs',
      'timeoutMs',
    ]),
    'target',
  )
  const guildId = snowflake(targetInput.guildId, 'target.guildId')
  const channelId = snowflake(targetInput.channelId, 'target.channelId')
  const docsChannelIdsInput = object(targetInput.docsChannelIds, 'target.docsChannelIds')
  exactKeys(docsChannelIdsInput, new Set(['public', 'restricted']), 'target.docsChannelIds')
  const docsChannelIds = {
    public: snowflake(docsChannelIdsInput.public, 'target.docsChannelIds.public'),
    restricted: snowflake(docsChannelIdsInput.restricted, 'target.docsChannelIds.restricted'),
  }
  if (docsChannelIds.public === docsChannelIds.restricted) {
    throw new LiveManifestError('target docs channels must be distinct')
  }
  if (Array.isArray(targetInput.allowedChannelIds) === false) {
    throw new LiveManifestError('target.allowedChannelIds must be an array')
  }
  const allowedChannelIds = new Set(
    targetInput.allowedChannelIds.map((value, index) => snowflake(value, `target.allowedChannelIds[${index}]`)),
  )
  const requiredChannelIds = [channelId, docsChannelIds.public, docsChannelIds.restricted]
  if (requiredChannelIds.some((requiredChannelId) => allowedChannelIds.has(requiredChannelId) === false) === true) {
    throw new LiveManifestError('every target channel must be explicitly allowlisted')
  }
  if (targetInput.requiredTopicSentinel !== topicSentinel) {
    throw new LiveManifestError(`target.requiredTopicSentinel must be ${topicSentinel}`)
  }

  const actorBotTokenRef = string(root.actorBotTokenRef, 'actorBotTokenRef')
  if (/^op:\/\/[^/]+\/[^/]+\/.+$/u.test(actorBotTokenRef) === false) {
    throw new LiveManifestError('actorBotTokenRef must be an op:// reference')
  }

  if (root.botControlSocket !== undefined && root.botAdminEndpoint !== undefined) {
    throw new LiveManifestError('manifest must not combine botControlSocket with botAdminEndpoint')
  }
  const botAdminEndpoint =
    root.botAdminEndpoint === undefined ? undefined : httpsEndpoint(root.botAdminEndpoint, 'botAdminEndpoint')
  let botControlSocket: string | undefined
  if (botAdminEndpoint === undefined) {
    const socket = string(root.botControlSocket, 'botControlSocket')
    const normalizedSocket = posix.normalize(socket)
    if (
      normalizedSocket !== socket ||
      normalizedSocket.startsWith('/run/discord-bot/staging/') === false ||
      normalizedSocket.endsWith('.sock') === false
    ) {
      throw new LiveManifestError('botControlSocket must be a normalized .sock path inside /run/discord-bot/staging')
    }
    botControlSocket = socket
  }

  return {
    schemaVersion: 1,
    environment: 'staging',
    actorBotTokenRef: actorBotTokenRef as `op://${string}`,
    ...(botAdminEndpoint === undefined ? {} : { botAdminEndpoint }),
    ...(botControlSocket === undefined ? {} : { botControlSocket }),
    target: {
      guildId,
      channelId,
      docsChannelIds,
      allowedChannelIds,
      requiredTopicSentinel: topicSentinel,
      pollIntervalMs: positiveInteger(targetInput.pollIntervalMs, 'target.pollIntervalMs'),
      timeoutMs: positiveInteger(targetInput.timeoutMs, 'target.timeoutMs'),
    },
  }
}
