import * as Schema from 'effect/Schema'

import { DiscordSnowflake } from '../threading/model.ts'

export const RetiredHistoricalApplicationId = '1310646763505582171' as const

export const ApplicationCommandKind = Schema.Literals([1, 2, 3, 4]).annotate({
  identifier: 'DiscordBot.ApplicationCommandKind',
})
export type ApplicationCommandKind = typeof ApplicationCommandKind.Type

const ApplicationCommandChoice = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
})

export const ApplicationCommandOption = Schema.Struct({
  type: Schema.Literal(3),
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
  description: Schema.Trimmed.check(Schema.isNonEmpty()),
  required: Schema.Boolean,
  autocomplete: Schema.optional(Schema.Boolean),
  choices: ApplicationCommandChoice.pipe(Schema.Array, Schema.optional),
  minLength: Schema.optional(Schema.Finite),
  maxLength: Schema.optional(Schema.Finite),
}).pipe(Schema.annotate({ identifier: 'DiscordBot.ApplicationCommandOption' }))
export type ApplicationCommandOption = typeof ApplicationCommandOption.Type

export const ApplicationIntegrationType = Schema.Literals([0, 1]).pipe(
  Schema.annotate({
    identifier: 'DiscordBot.ApplicationIntegrationType',
  }),
)
export type ApplicationIntegrationType = typeof ApplicationIntegrationType.Type

export const InteractionContextType = Schema.Literals([0, 1, 2]).pipe(
  Schema.annotate({
    identifier: 'DiscordBot.InteractionContextType',
  }),
)
export type InteractionContextType = typeof InteractionContextType.Type

/** Scope-independent command semantics owned by this bot. */
export const ApplicationCommand = Schema.Struct({
  type: ApplicationCommandKind,
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
  description: Schema.String,
  options: Schema.Array(ApplicationCommandOption),
  defaultMemberPermissions: Schema.NullOr(Schema.String),
  nsfw: Schema.Boolean,
  integrationTypes: ApplicationIntegrationType.pipe(Schema.Array, Schema.optional),
  contexts: InteractionContextType.pipe(Schema.Array, Schema.optional),
}).pipe(Schema.annotate({ identifier: 'DiscordBot.ApplicationCommand' }))
export type ApplicationCommand = typeof ApplicationCommand.Type

export const GuildCommandScope = Schema.TaggedStruct('GuildCommandScope', {
  applicationId: DiscordSnowflake,
  guildId: DiscordSnowflake,
}).annotate({ identifier: 'DiscordBot.GuildCommandScope' })
export type GuildCommandScope = typeof GuildCommandScope.Type

export const GlobalCommandScope = Schema.TaggedStruct('GlobalCommandScope', {
  applicationId: DiscordSnowflake,
}).annotate({ identifier: 'DiscordBot.GlobalCommandScope' })
export type GlobalCommandScope = typeof GlobalCommandScope.Type

export const ApplicationCommandScope = Schema.Union([GuildCommandScope, GlobalCommandScope]).annotate({
  identifier: 'DiscordBot.ApplicationCommandScope',
})
export type ApplicationCommandScope = typeof ApplicationCommandScope.Type

export const ApplicationCommandChangeKind = Schema.Literals(['create', 'update', 'delete', 'unchanged']).annotate({
  identifier: 'DiscordBot.ApplicationCommandChangeKind',
})
export type ApplicationCommandChangeKind = typeof ApplicationCommandChangeKind.Type

export const ApplicationCommandChange = Schema.Struct({
  kind: ApplicationCommandChangeKind,
  key: Schema.String,
  desired: Schema.optional(ApplicationCommand),
  actual: Schema.optional(ApplicationCommand),
}).annotate({ identifier: 'DiscordBot.ApplicationCommandChange' })
export type ApplicationCommandChange = typeof ApplicationCommandChange.Type

export const ApplicationCommandsDiff = Schema.Struct({
  changes: Schema.Array(ApplicationCommandChange),
  duplicateActualKeys: Schema.Array(Schema.String),
  hasChanges: Schema.Boolean,
}).annotate({ identifier: 'DiscordBot.ApplicationCommandsDiff' })
export type ApplicationCommandsDiff = typeof ApplicationCommandsDiff.Type

export class ApplicationCommandInventoryInvalid extends Schema.TaggedError<ApplicationCommandInventoryInvalid>()(
  'ApplicationCommandInventoryInvalid',
  {
    duplicateKeys: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export class ApplicationCommandRemoteShapeUnsupported extends Schema.TaggedError<ApplicationCommandRemoteShapeUnsupported>()(
  'ApplicationCommandRemoteShapeUnsupported',
  {
    commandKey: Schema.String,
    message: Schema.String,
  },
) {}

export class ApplicationCommandResidualDrift extends Schema.TaggedError<ApplicationCommandResidualDrift>()(
  'ApplicationCommandResidualDrift',
  {
    diff: ApplicationCommandsDiff,
    message: Schema.String,
  },
) {}

export class ApplicationCommandScopeRejected extends Schema.TaggedError<ApplicationCommandScopeRejected>()(
  'ApplicationCommandScopeRejected',
  {
    applicationId: Schema.String,
    message: Schema.String,
  },
) {}

export class ApplicationCommandRestError extends Schema.TaggedError<ApplicationCommandRestError>()(
  'ApplicationCommandRestError',
  {
    operation: Schema.Literals(['list', 'replace']),
    scope: Schema.Literals(['guild', 'global']),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const commandKey = (command: Pick<ApplicationCommand, 'name' | 'type'>) => `${command.type}:${command.name}`

export const assertAllowedApplicationId = (applicationId: string): ApplicationCommandScopeRejected | undefined =>
  applicationId === RetiredHistoricalApplicationId
    ? new ApplicationCommandScopeRejected({
        applicationId,
        message: 'The retired historical LiveStore application is fenced from command reads and writes',
      })
    : undefined
