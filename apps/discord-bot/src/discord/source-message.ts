import { Schema } from "effect"
import { DiscordMessageRef, DiscordSnowflake, type DiscordSnowflake as DiscordSnowflakeType, type SourceChannelKind } from "../threading/model.ts"
import type { DiscordMessageRef as DiscordMessageRefType } from "../threading/model.ts"

export class DiscordSourceMessageDecodeError extends Schema.TaggedError<DiscordSourceMessageDecodeError>()(
  "DiscordSourceMessageDecodeError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The small, content-bearing projection shared by Gateway and operator reads. */
export interface DiscordSourceMessageFacts {
  readonly source: DiscordMessageRefType
  readonly authorId: DiscordSnowflakeType
  readonly messageType: number
  readonly content: string
  readonly isReply: boolean
  readonly authorIsBot: boolean
  readonly authorIsSystem: boolean
  readonly hasWebhookAuthor: boolean
  readonly hasApplicationAuthor: boolean
  readonly attachmentCount: number
  readonly hasPoll: boolean
  readonly stickerCount: number
  readonly existingThreadId?: DiscordSnowflakeType
  readonly sourceChannelKind?: SourceChannelKind
}

/**
 * Decode a Discord message only when it is the exact requested remote object.
 * Keeping this check in one place prevents the Gateway and operator paths from
 * slowly acquiring different identity and eligibility semantics.
 */
export const decodeDiscordSourceMessage = (
  expected: DiscordMessageRefType,
  value: unknown,
): DiscordSourceMessageFacts => {
  if (isRecord(value) === false || value.guild_id !== expected.guildId || value.channel_id !== expected.channelId || value.id !== expected.messageId) {
    throw new TypeError("Discord source message identity did not match the requested guild, channel, and message")
  }
  if (isRecord(value.author) === false || typeof value.author.id !== "string") {
    throw new TypeError("Discord source message author was invalid")
  }
  const authorId = Schema.decodeUnknownSync(DiscordSnowflake)(value.author.id)
  if (typeof value.content !== "string" || typeof value.type !== "number" || Number.isInteger(value.type) === false || value.type < 0 || Array.isArray(value.attachments) === false) {
    throw new TypeError("Discord source message shape was invalid")
  }
  const isReply = value.message_reference !== undefined
  const reference = value.message_reference
  if (isReply === true && (isRecord(reference) === false || typeof reference.message_id !== "string")) {
    throw new TypeError("Discord source message reply reference was invalid")
  }
  if (isReply === true && isRecord(reference) === true) Schema.decodeUnknownSync(DiscordSnowflake)(reference.message_id)
  const hasThread = value.thread !== undefined
  const thread = value.thread
  if (hasThread === true && (isRecord(thread) === false || typeof thread.id !== "string")) {
    throw new TypeError("Discord source message existing thread was invalid")
  }
  const existingThreadId = hasThread === true
    ? Schema.decodeUnknownSync(DiscordSnowflake)(isRecord(thread) === true ? thread.id : undefined)
    : undefined
  const sourceChannelKind = isRecord(value.channel) === true && typeof value.channel.type === "number"
    ? channelKind(value.channel.type)
    : undefined
  return {
    source: expected,
    authorId,
    messageType: value.type,
    content: value.content,
    isReply,
    authorIsBot: value.author.bot === true,
    authorIsSystem: value.author.system === true,
    hasWebhookAuthor: typeof value.webhook_id === "string",
    hasApplicationAuthor: typeof value.application_id === "string",
    attachmentCount: value.attachments.length,
    hasPoll: value.poll !== undefined,
    stickerCount: Array.isArray(value.sticker_items) === true ? value.sticker_items.length : 0,
    ...(existingThreadId === undefined ? {} : { existingThreadId }),
    ...(sourceChannelKind === undefined ? {} : { sourceChannelKind }),
  }
}

const channelKind = (type: number): SourceChannelKind | undefined => {
  switch (type) {
    case 0: return "GuildText"
    case 5: return "GuildAnnouncement"
    case 10: return "PublicThread"
    case 11: return "AnnouncementThread"
    case 12: return "PrivateThread"
    case 15: return "GuildForum"
    case 16: return "GuildMedia"
    default: return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
