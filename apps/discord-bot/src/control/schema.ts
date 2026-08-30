import { Schema } from 'effect'

import { DiscordMessageRef, DiscordSnowflake } from '../threading/model.ts'

export { DiscordMessageRef, DiscordSnowflake }
export type {
  DiscordMessageRef as DiscordMessageRefType,
  DiscordSnowflake as DiscordSnowflakeType,
} from '../threading/model.ts'

export const DeploymentEnvironment = Schema.Literals(['staging', 'production']).annotate({
  identifier: 'DiscordBot.DeploymentEnvironment',
})
export type DeploymentEnvironment = typeof DeploymentEnvironment.Type

export const OperatorReason = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMinLength(3))
  .pipe(Schema.brand('OperatorReason'))
  .annotate({ identifier: 'DiscordBot.OperatorReason' })
export type OperatorReason = typeof OperatorReason.Type

export const AmbiguousJournalState = Schema.Literals(['creating', 'unknown_external'])

export const ControlResult = Schema.Struct({
  _tag: Schema.Literals(['Success', 'AlreadySatisfied', 'Planned', 'Unrun']),
  summary: Schema.Trimmed.check(Schema.isNonEmpty()),
  correlationId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  receiptId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  nextCommand: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
}).annotate({ identifier: 'DiscordBot.ControlResult' })
export type ControlResult = typeof ControlResult.Type

export class InvalidControlInput extends Schema.TaggedError<InvalidControlInput>()('InvalidControlInput', {
  message: Schema.Trimmed.check(Schema.isNonEmpty()),
}) {}

export class ControlAuthorizationRejected extends Schema.TaggedError<ControlAuthorizationRejected>()(
  'ControlAuthorizationRejected',
  { message: Schema.Trimmed.check(Schema.isNonEmpty()) },
) {}

export class ControlDependencyUnavailable extends Schema.TaggedError<ControlDependencyUnavailable>()(
  'ControlDependencyUnavailable',
  {
    dependency: Schema.Trimmed.check(Schema.isNonEmpty()),
    message: Schema.Trimmed.check(Schema.isNonEmpty()),
  },
) {}

export class ControlApplicationFailure extends Schema.TaggedError<ControlApplicationFailure>()(
  'ControlApplicationFailure',
  { message: Schema.Trimmed.check(Schema.isNonEmpty()) },
) {}

export class ControlAmbiguousOutcome extends Schema.TaggedError<ControlAmbiguousOutcome>()('ControlAmbiguousOutcome', {
  message: Schema.Trimmed.check(Schema.isNonEmpty()),
  correlationId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
}) {}

export class ControlGateUnrun extends Schema.TaggedError<ControlGateUnrun>()('ControlGateUnrun', {
  message: Schema.Trimmed.check(Schema.isNonEmpty()),
}) {}

export const ControlError = Schema.Union([
  InvalidControlInput,
  ControlAuthorizationRejected,
  ControlDependencyUnavailable,
  ControlApplicationFailure,
  ControlAmbiguousOutcome,
  ControlGateUnrun,
]).annotate({ identifier: 'DiscordBot.ControlError' })
export type ControlError = typeof ControlError.Type

export const MutationGuard = {
  environment: DeploymentEnvironment,
  apply: Schema.Literal(true),
  reason: OperatorReason,
} as const

export const EmptyPayload = Schema.Struct({})
