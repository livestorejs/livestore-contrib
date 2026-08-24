import { Schema } from 'effect'
import { Rpc, RpcClient, RpcGroup } from 'effect/unstable/rpc'

import {
  AmbiguousJournalState,
  ControlError,
  ControlResult,
  DeploymentEnvironment,
  DiscordMessageRef,
  EmptyPayload,
  MutationGuard,
  OperatorReason,
} from './schema.ts'

const controlRpc = <const TTag extends string, TPayload extends Schema.Top | Schema.Struct.Fields>(
  tag: TTag,
  payload: TPayload,
) => Rpc.make(tag, { payload, success: ControlResult, error: ControlError, stream: false })

export const ThreadInspect = controlRpc('ThreadInspect', { source: DiscordMessageRef })
export const ThreadPlan = controlRpc('ThreadPlan', {
  source: DiscordMessageRef,
  name: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  noAi: Schema.Boolean,
})
export const ThreadCreate = controlRpc('ThreadCreate', {
  source: DiscordMessageRef,
  ...MutationGuard,
  name: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
})
export const ThreadStatus = controlRpc('ThreadStatus', { source: DiscordMessageRef })
export const ThreadReconcile = controlRpc('ThreadReconcile', {
  source: Schema.optional(DiscordMessageRef),
  all: Schema.Boolean,
  state: Schema.optional(AmbiguousJournalState),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  apply: Schema.Boolean,
  environment: Schema.optional(DeploymentEnvironment),
  reason: Schema.optional(OperatorReason),
})
export const ThreadPolicyExplain = controlRpc('ThreadPolicyExplain', { source: DiscordMessageRef })
export const DocsQuery = controlRpc('DocsQuery', {
  query: Schema.Trimmed.check(Schema.isNonEmpty()),
  refreshCorpus: Schema.Boolean,
})
export const DocsStatus = controlRpc('DocsStatus', EmptyPayload)
export const RuntimeHealth = controlRpc('RuntimeHealth', { watch: Schema.Boolean })
export const RuntimeStatus = controlRpc('RuntimeStatus', EmptyPayload)
export const ConfigValidate = controlRpc('ConfigValidate', {
  file: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
})
export const EffectiveConfig = controlRpc('EffectiveConfig', EmptyPayload)
export const AuthStatus = controlRpc('AuthStatus', EmptyPayload)
export const ApplicationCommandsDiff = controlRpc('ApplicationCommandsDiff', EmptyPayload)
export const ApplicationCommandsSync = controlRpc('ApplicationCommandsSync', MutationGuard)
export const StagingE2ERun = controlRpc('StagingE2ERun', {
  environment: Schema.Literal('staging'),
  apply: Schema.Literal(true),
  reason: OperatorReason,
  confirmLiveWrite: Schema.Literal(true),
})

/** The sole administrative application contract; it intentionally exposes no generic Discord REST operation. */
export const BotControl = RpcGroup.make(
  ThreadInspect,
  ThreadPlan,
  ThreadCreate,
  ThreadStatus,
  ThreadReconcile,
  ThreadPolicyExplain,
  DocsQuery,
  DocsStatus,
  RuntimeHealth,
  RuntimeStatus,
  ConfigValidate,
  EffectiveConfig,
  AuthStatus,
  ApplicationCommandsDiff,
  ApplicationCommandsSync,
  StagingE2ERun,
)

export type BotControlClient = RpcClient.FromGroup<typeof BotControl>
export type BotControlOperation = RpcGroup.Rpcs<typeof BotControl>['_tag']

export const BotControlOperationNames = [...BotControl.requests.keys()] as readonly BotControlOperation[]

export const EnvironmentPayload = DeploymentEnvironment
