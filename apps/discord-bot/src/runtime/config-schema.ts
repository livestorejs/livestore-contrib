import { Effect, Schema } from 'effect'

import { ApplicationCommandScope, RetiredHistoricalApplicationId } from '../application-commands/index.ts'
import { DeploymentBase, normalizeDeploymentConfig } from './deployment-contract.ts'
import type { BotDeploymentConfig } from './deployment-contract.ts'

/**
 * Portable runtime-config schema: split from `config.ts` (whose
 * `loadRuntimeConfig` needs `node:fs`) so node-free hosts — the Cloudflare
 * worker's runtime-config store and event-handler layer — decode the exact
 * same payload, including its cross-field deployment-contract filter.
 * `config.ts` re-exports everything here.
 */
const NonEmpty = Schema.Trimmed.check(Schema.isNonEmpty())
const AbsolutePath = NonEmpty.check(
  Schema.makeFilter((value: string) => value.startsWith('/'), { expected: 'an absolute filesystem path' }),
)
const HostFields = {
  commandScope: ApplicationCommandScope,
  legacyCommands: Schema.Array(NonEmpty),
  stateDirectory: AbsolutePath,
  controlSocketPath: AbsolutePath,
  health: Schema.Struct({
    host: Schema.Literal('127.0.0.1'),
    port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  }),
} as const
const E2EFields = {
  e2e: Schema.optional(
    Schema.Struct({
      actorApplicationId: Schema.String,
      actorTokenSecretRef: NonEmpty,
      targetChannelId: Schema.String,
      requiredPurposeMarker: NonEmpty,
    }),
  ),
}
const FakeConfig = Schema.TaggedStruct('fake', { ...DeploymentBase, ...HostFields, ...E2EFields })
const RealConfig = Schema.TaggedStruct('real', {
  ...DeploymentBase,
  ...HostFields,
  ...E2EFields,
  credentials: Schema.Struct({
    discordTokenFile: AbsolutePath,
    openAiApiKeyFile: AbsolutePath,
    docsCorrelationKeyFile: AbsolutePath,
  }),
})

export const RuntimeConfigPayload = Schema.Union([FakeConfig, RealConfig])
  .check(
    Schema.makeFilter(
      (config) => {
        if (config.applicationId === RetiredHistoricalApplicationId) return false
        if (config.commandScope.applicationId !== config.applicationId) return false
        if (config.environment === 'staging' && config.commandScope._tag !== 'GuildCommandScope') return false
        if (config.commandScope._tag === 'GuildCommandScope' && config.commandScope.guildId !== config.guildId)
          return false
        if (config.environment === 'staging' && config.e2e === undefined) return false
        if (config.environment === 'production' && config.e2e !== undefined) return false
        try {
          const {
            _tag: _mode,
            commandScope: _scope,
            legacyCommands: _legacy,
            stateDirectory: _state,
            controlSocketPath: _socket,
            health: _health,
            ...withCredentials
          } = config
          const { credentials: _credentials, ...deployment } = withCredentials as typeof withCredentials & {
            readonly credentials?: unknown
          }
          normalizeDeploymentConfig(deployment as BotDeploymentConfig)
          return true
        } catch {
          return false
        }
      },
      { expected: 'a validated deployment contract with host realization fields' },
    ),
  )
  .annotate({ identifier: 'DiscordBot.Runtime.ConfigPayload' })
export type RuntimeConfigPayload = typeof RuntimeConfigPayload.Type

export const RuntimeConfigFile = Schema.Struct({
  apiVersion: Schema.Literal(1),
  payload: RuntimeConfigPayload,
}).annotate({ identifier: 'DiscordBot.Runtime.ConfigFile.v1' })
export class RuntimeConfigError extends Schema.TaggedError<RuntimeConfigError>()('RuntimeConfigError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const summarizeConfig = (config: RuntimeConfigPayload) => ({
  apiVersion: 1,
  mode: config._tag,
  environment: config.environment,
  applicationId: config.applicationId,
  commandScope: config.commandScope._tag,
  guildId: config.guildId,
  actionChannelCount: config.actionChannelIds.length,
  parentChannelCount: config.actionChannelIds.length,
  aiTitleChannelCount: config.aiTitleChannelIds.length,
  publicDocsChannelCount: config.docsAudience.publicChannelIds.length,
  restrictedDocsChannelCount: config.docsAudience.roleRestrictedChannelIds.length,
  docsRoleCount: config.docsAudience.contributorMaintainerRoleIds.length,
  releaseId: config.releaseId,
  stateDirectory: config.stateDirectory,
  controlSocketPath: config.controlSocketPath,
  health: config.health,
})
