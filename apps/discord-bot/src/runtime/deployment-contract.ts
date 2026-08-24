import { Schema } from "effect"

const NonEmpty = Schema.Trimmed.check(Schema.isNonEmpty())
const Snowflake = Schema.String.check(Schema.isPattern(/^\d{17,20}$/))
const SecretRef = NonEmpty.check(Schema.isMaxLength(512))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const DeploymentTelemetry = Schema.Struct({
  sink: Schema.Literal("dev3-tempo"),
  delivery: Schema.Literal("best-effort"),
  accessBoundary: Schema.Literal("tailnet-trusted-grafana"),
  retentionDays: PositiveInt.check(Schema.isLessThanOrEqualTo(30)),
})

export const DeploymentOpenAi = Schema.Struct({
  projectId: NonEmpty.check(Schema.isMaxLength(128)),
  serviceAccountSecretRef: SecretRef,
  retentionPosture: Schema.Literal("standard-store-false"),
  limits: Schema.Struct({
    requestsPerMemberPerHour: PositiveInt,
    requestsPerMinute: PositiveInt,
    inputTokensPerRequest: PositiveInt,
    outputTokensPerRequest: PositiveInt,
    monthlyCostUsdMicros: PositiveInt,
  }),
})

export const DeploymentBase = {
  schemaVersion: Schema.Literal(1),
  environment: Schema.Literals(["staging", "production"]),
  applicationId: Snowflake,
  guildId: Snowflake,
  actionChannelIds: Schema.Array(Snowflake),
  aiTitleChannelIds: Schema.Array(Snowflake),
  docsAudience: Schema.Struct({
    publicChannelIds: Schema.Array(Snowflake),
    roleRestrictedChannelIds: Schema.Array(Snowflake),
    contributorMaintainerRoleIds: Schema.Array(Snowflake),
  }),
  stagingOnlyChannelIds: Schema.Array(Snowflake),
  botTokenSecretRef: SecretRef,
  openAi: DeploymentOpenAi,
  releaseId: NonEmpty.check(Schema.isMaxLength(256)),
  telemetry: DeploymentTelemetry,
} as const

export const BotDeploymentConfig = Schema.Union([
  Schema.Struct({
    ...DeploymentBase,
    environment: Schema.Literal("production"),
  }),
  Schema.Struct({
    ...DeploymentBase,
    environment: Schema.Literal("staging"),
    e2e: Schema.Struct({
      actorApplicationId: Snowflake,
      actorTokenSecretRef: SecretRef,
      targetChannelId: Snowflake,
      requiredPurposeMarker: NonEmpty.check(Schema.isMaxLength(256)),
    }),
  }),
]).annotate({ identifier: "DiscordBot.Runtime.BotDeploymentConfig.v1" })
export type BotDeploymentConfig = typeof BotDeploymentConfig.Type

/**
 * Applies the cross-field rules that cannot be expressed by the JSON shape.
 * Arrays are canonicalized here so deployment controllers do not accidentally
 * create duplicate action or audience targets.
 */
export const normalizeDeploymentConfig = (config: BotDeploymentConfig): BotDeploymentConfig => {
  const normalized = {
    ...config,
    actionChannelIds: unique(config.actionChannelIds),
    aiTitleChannelIds: unique(config.aiTitleChannelIds),
    stagingOnlyChannelIds: unique(config.stagingOnlyChannelIds),
    docsAudience: {
      ...config.docsAudience,
      publicChannelIds: unique(config.docsAudience.publicChannelIds),
      roleRestrictedChannelIds: unique(config.docsAudience.roleRestrictedChannelIds),
      contributorMaintainerRoleIds: unique(config.docsAudience.contributorMaintainerRoleIds),
    },
  }
  if (normalized.actionChannelIds.length === 0) throw new Error("actionChannelIds must be non-empty")
  if (subset(normalized.aiTitleChannelIds, normalized.actionChannelIds) === false) {
    throw new Error("aiTitleChannelIds must be a subset of actionChannelIds")
  }
  if (subset(normalized.aiTitleChannelIds, normalized.docsAudience.publicChannelIds) === false) {
    throw new Error("AI-title channels must be public docs channels")
  }
  if (intersects(normalized.docsAudience.publicChannelIds, normalized.docsAudience.roleRestrictedChannelIds) === true) {
    throw new Error("docs audience channel sets must be disjoint")
  }
  if (normalized.docsAudience.roleRestrictedChannelIds.length > 0 && normalized.docsAudience.contributorMaintainerRoleIds.length === 0) {
    throw new Error("role-restricted docs channels require contributor/maintainer roles")
  }
  if (normalized.environment === "production" && intersects(normalized.actionChannelIds, normalized.stagingOnlyChannelIds) === true) {
    throw new Error("production action channels cannot overlap staging-only channels")
  }
  if (normalized.environment === "staging" && normalized.actionChannelIds.includes(normalized.e2e.targetChannelId) === false) {
    throw new Error("staging E2E target must be an action channel")
  }
  return normalized
}

const unique = <T>(values: ReadonlyArray<T>): Array<T> => [...new Set(values)]
const subset = (values: ReadonlyArray<string>, superset: ReadonlyArray<string>) => values.every(value => superset.includes(value))
const intersects = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => left.some(value => right.includes(value))
