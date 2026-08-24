import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { DiscordSnowflake, InteractionRoute } from "./actions.ts"
import { SourceChannelKind } from "../threading/model.ts"

export const AutomaticMessage = Schema.Struct({
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  messageId: DiscordSnowflake,
  authorId: DiscordSnowflake,
  authorIsBot: Schema.Boolean,
  authorIsSystem: Schema.Boolean,
  hasWebhookAuthor: Schema.Boolean,
  hasApplicationAuthor: Schema.Boolean,
  content: Schema.String,
  messageType: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  isReply: Schema.Boolean,
  hasAttachments: Schema.Boolean,
  hasPoll: Schema.Boolean,
  existingThreadId: Schema.optional(DiscordSnowflake),
  sourceChannelKind: Schema.optional(SourceChannelKind),
}).annotate({ identifier: "Discord.AutomaticMessage" })
export type AutomaticMessage = typeof AutomaticMessage.Type

export const InteractionActor = Schema.Struct({
  userId: DiscordSnowflake,
  roleIds: Schema.Array(DiscordSnowflake),
  effectivePermissions: Schema.String,
}).annotate({ identifier: "Discord.InteractionActor" })
export type InteractionActor = typeof InteractionActor.Type

export const CreateThreadInteraction = Schema.Struct({
  route: InteractionRoute,
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  actor: InteractionActor,
  sourceMessage: AutomaticMessage,
  applicationPermissions: Schema.String,
}).annotate({ identifier: "Discord.CreateThreadInteraction" })
export type CreateThreadInteraction = typeof CreateThreadInteraction.Type

export const DocsInteraction = Schema.Struct({
  route: InteractionRoute,
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  actor: InteractionActor,
  applicationPermissions: Schema.String,
  query: Schema.Trimmed.check(Schema.isNonEmpty()),
}).annotate({ identifier: "Discord.DocsInteraction" })
export type DocsInteraction = typeof DocsInteraction.Type

/** Decoded inbound events. Implementations invoke shared product workflows. */
export interface DiscordEventHandlersService {
  readonly onAutomaticMessage: (input: AutomaticMessage) => Effect.Effect<void>
  readonly onCreateThreadInteraction: (
    input: CreateThreadInteraction,
  ) => Effect.Effect<void>
  readonly onDocsInteraction: (input: DocsInteraction) => Effect.Effect<void>
}

export class DiscordEventHandlers extends Context.Service<
  DiscordEventHandlers,
  DiscordEventHandlersService
>()("livestore-discord/DiscordEventHandlers") {}
