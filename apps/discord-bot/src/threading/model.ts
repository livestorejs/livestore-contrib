import { Schema } from 'effect'

export const DiscordSnowflake = Schema.String.check(Schema.isPattern(/^\d{17,20}$/))
  .pipe(Schema.brand('DiscordSnowflake'))
  .annotate({ identifier: 'LiveStoreDiscord.Threading.DiscordSnowflake' })
export type DiscordSnowflake = typeof DiscordSnowflake.Type

export const EnvironmentName = Schema.Trimmed.check(Schema.isNonEmpty())
  .pipe(Schema.brand('DiscordBotEnvironmentName'))
  .annotate({ identifier: 'LiveStoreDiscord.Threading.EnvironmentName' })
export type EnvironmentName = typeof EnvironmentName.Type

export const ThreadName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value: string) => [...value].length <= 100, {
    expected: 'a Discord thread name of at most 100 Unicode code points',
  }),
)
  .pipe(Schema.brand('DiscordThreadName'))
  .annotate({ identifier: 'LiveStoreDiscord.Threading.ThreadName' })
export type ThreadName = typeof ThreadName.Type

export const DiscordMessageRef = Schema.Struct({
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  messageId: DiscordSnowflake,
}).annotate({ identifier: 'LiveStoreDiscord.Threading.DiscordMessageRef' })
export type DiscordMessageRef = typeof DiscordMessageRef.Type

export const ThreadClaimHandle = Schema.Struct({
  sourceMessageId: DiscordSnowflake,
  claimToken: Schema.String.check(Schema.isUUID(4)),
}).annotate({ identifier: 'LiveStoreDiscord.Threading.ThreadClaimHandle' })
export type ThreadClaimHandle = typeof ThreadClaimHandle.Type

export const SourceChannelKind = Schema.Literals([
  'GuildText',
  'GuildAnnouncement',
  'GuildForum',
  'GuildMedia',
  'PublicThread',
  'PrivateThread',
  'AnnouncementThread',
  'DirectMessage',
  'GroupDirectMessage',
])
export type SourceChannelKind = typeof SourceChannelKind.Type

export const MessageKind = Schema.Literals(['Default', 'Reply', 'System'])
export type MessageKind = typeof MessageKind.Type

export const AuthorKind = Schema.Literals(['Human', 'Bot', 'Webhook', 'Application'])
export type AuthorKind = typeof AuthorKind.Type

export const AutomaticTrigger = Schema.TaggedStruct('Automatic', {
  deliveryCorrelation: Schema.String,
})
export const DiscordManualTrigger = Schema.TaggedStruct('DiscordManual', {
  actorId: DiscordSnowflake,
  authorized: Schema.Boolean,
  deliveryCorrelation: Schema.String,
})
export const OperatorTrigger = Schema.TaggedStruct('Operator', {
  principal: Schema.Trimmed.check(Schema.isNonEmpty()),
  authorized: Schema.Boolean,
  reason: Schema.Trimmed.check(Schema.isNonEmpty()),
  requestedTitle: Schema.optional(Schema.String),
})
export const ThreadTrigger = Schema.Union([AutomaticTrigger, DiscordManualTrigger, OperatorTrigger]).annotate({
  identifier: 'LiveStoreDiscord.Threading.ThreadTrigger',
})
export type ThreadTrigger = typeof ThreadTrigger.Type

/** Decoded source facts. Raw content is intentionally absent from every outcome. */
export const ThreadCandidate = Schema.Struct({
  environment: EnvironmentName,
  source: DiscordMessageRef,
  sourceChannelKind: SourceChannelKind,
  messageKind: MessageKind,
  hasMessageReference: Schema.Boolean,
  authorKind: AuthorKind,
  existingThreadId: Schema.optional(DiscordSnowflake),
  content: Schema.String,
  attachmentCount: Schema.Natural,
  hasPoll: Schema.Boolean,
  stickerCount: Schema.Natural,
  trigger: ThreadTrigger,
}).annotate({ identifier: 'LiveStoreDiscord.Threading.ThreadCandidate' })
export type ThreadCandidate = typeof ThreadCandidate.Type

export const AutomaticRejectionReason = Schema.Literals([
  'wrong_environment',
  'wrong_guild',
  'parent_channel_not_configured',
  'unsupported_channel_kind',
  'source_is_thread_or_dm',
  'non_ordinary_message',
  'reply',
  'bot_author',
  'webhook_author',
  'application_author',
  'existing_thread',
  'empty',
  'greeting',
  'reaction',
  'recognized_command',
  'url_only',
  'numeric_or_version_only',
  'reaction_symbols_only',
])
export type AutomaticRejectionReason = typeof AutomaticRejectionReason.Type

export const Created = Schema.TaggedStruct('Created', {
  source: DiscordMessageRef,
  threadId: DiscordSnowflake,
})
export const AlreadySatisfied = Schema.TaggedStruct('AlreadySatisfied', {
  source: DiscordMessageRef,
  threadId: DiscordSnowflake,
})
export const PolicyRejected = Schema.TaggedStruct('PolicyRejected', {
  source: DiscordMessageRef,
  reason: AutomaticRejectionReason,
})
export const AuthorizationRejected = Schema.TaggedStruct('AuthorizationRejected', {
  source: DiscordMessageRef,
})
export const TransientFailure = Schema.TaggedStruct('TransientFailure', {
  source: DiscordMessageRef,
  failureCode: Schema.String,
})
export const TerminalFailure = Schema.TaggedStruct('TerminalFailure', {
  source: DiscordMessageRef,
  failureCode: Schema.String,
})
export const ThreadOutcome = Schema.Union([
  Created,
  AlreadySatisfied,
  PolicyRejected,
  AuthorizationRejected,
  TransientFailure,
  TerminalFailure,
]).annotate({ identifier: 'LiveStoreDiscord.Threading.ThreadOutcome' })
export type ThreadOutcome = typeof ThreadOutcome.Type
