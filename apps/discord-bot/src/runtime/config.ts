import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { ApplicationCommandScope, RetiredHistoricalApplicationId } from "../application-commands/index.ts"
import { BotDeploymentConfig, DeploymentBase, normalizeDeploymentConfig } from "./deployment-contract.ts"

const NonEmpty = Schema.Trimmed.check(Schema.isNonEmpty())
const AbsolutePath = NonEmpty.check(Schema.makeFilter((value: string) => value.startsWith("/"), { expected: "an absolute filesystem path" }))
const HostFields = {
  commandScope: ApplicationCommandScope,
  legacyCommands: Schema.Array(NonEmpty),
  stateDirectory: AbsolutePath,
  controlSocketPath: AbsolutePath,
  health: Schema.Struct({ host: Schema.Literal("127.0.0.1"), port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })) }),
} as const
const E2EFields = { e2e: Schema.optional(Schema.Struct({ actorApplicationId: Schema.String, actorTokenSecretRef: NonEmpty, targetChannelId: Schema.String, requiredPurposeMarker: NonEmpty })) }
const FakeConfig = Schema.TaggedStruct("fake", { ...DeploymentBase, ...HostFields, ...E2EFields })
const RealConfig = Schema.TaggedStruct("real", { ...DeploymentBase, ...HostFields, ...E2EFields, credentials: Schema.Struct({ discordTokenFile: AbsolutePath, openAiApiKeyFile: AbsolutePath, docsCorrelationKeyFile: AbsolutePath }) })

export const RuntimeConfigPayload = Schema.Union([FakeConfig, RealConfig]).check(Schema.makeFilter(config => {
  if (config.applicationId === RetiredHistoricalApplicationId) return false
  if (config.commandScope.applicationId !== config.applicationId) return false
  if (config.environment === "staging" && config.commandScope._tag !== "GuildCommandScope") return false
  if (config.commandScope._tag === "GuildCommandScope" && config.commandScope.guildId !== config.guildId) return false
  if (config.environment === "staging" && config.e2e === undefined) return false
  if (config.environment === "production" && config.e2e !== undefined) return false
  try {
    const { _tag: _mode, commandScope: _scope, legacyCommands: _legacy, stateDirectory: _state, controlSocketPath: _socket, health: _health, ...withCredentials } = config
    const { credentials: _credentials, ...deployment } = withCredentials as typeof withCredentials & { readonly credentials?: unknown }
    normalizeDeploymentConfig(deployment as BotDeploymentConfig)
    return true
  } catch { return false }
}, { expected: "a validated deployment contract with host realization fields" })).annotate({ identifier: "DiscordBot.Runtime.ConfigPayload" })
export type RuntimeConfigPayload = typeof RuntimeConfigPayload.Type

export const RuntimeConfigFile = Schema.Struct({ apiVersion: Schema.Literal(1), payload: RuntimeConfigPayload }).annotate({ identifier: "DiscordBot.Runtime.ConfigFile.v1" })
export class RuntimeConfigError extends Schema.TaggedError<RuntimeConfigError>()("RuntimeConfigError", { path: Schema.String, message: Schema.String, cause: Schema.optional(Schema.Defect()) }) {}

export const loadRuntimeConfig = Effect.fn("runtime.config.load")(function* (path: string) {
  const text = yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: cause => new RuntimeConfigError({ path, message: "Could not read runtime config", cause }) })
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeConfigFile), { onExcessProperty: "error" })(text).pipe(Effect.mapError(cause => new RuntimeConfigError({ path, message: "Runtime config is invalid", cause })), Effect.map(({ payload }) => payload))
})

export const summarizeConfig = (config: RuntimeConfigPayload) => ({
  apiVersion: 1, mode: config._tag, environment: config.environment, applicationId: config.applicationId,
  commandScope: config.commandScope._tag, guildId: config.guildId, actionChannelCount: config.actionChannelIds.length,
  parentChannelCount: config.actionChannelIds.length,
  aiTitleChannelCount: config.aiTitleChannelIds.length, publicDocsChannelCount: config.docsAudience.publicChannelIds.length,
  restrictedDocsChannelCount: config.docsAudience.roleRestrictedChannelIds.length,
  docsRoleCount: config.docsAudience.contributorMaintainerRoleIds.length, releaseId: config.releaseId,
  stateDirectory: config.stateDirectory, controlSocketPath: config.controlSocketPath, health: config.health,
})
