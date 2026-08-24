import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { DiscordMessageRef } from "../threading/model.ts"
import { decodeDiscordSourceMessage } from "./source-message.ts"

const source = Schema.decodeUnknownSync(DiscordMessageRef)({
  guildId: "100000000000000001",
  channelId: "100000000000000002",
  messageId: "100000000000000003",
})

describe("Discord source message decoder", () => {
  it("decodes the shared Gateway/operator projection", () => {
    expect(decodeDiscordSourceMessage(source, {
      id: source.messageId,
      guild_id: source.guildId,
      channel_id: source.channelId,
      author: { id: "100000000000000004", bot: false, system: false },
      content: "source",
      type: 0,
      message_reference: { message_id: "100000000000000005" },
      attachments: [{ id: "attachment" }],
      poll: {},
      sticker_items: [{ id: "sticker" }],
      thread: { id: "100000000000000006" },
      channel: { type: 15 },
    })).toMatchObject({
      source,
      authorId: "100000000000000004",
      messageType: 0,
      isReply: true,
      attachmentCount: 1,
      hasPoll: true,
      stickerCount: 1,
      existingThreadId: "100000000000000006",
      sourceChannelKind: "GuildForum",
    })
  })

  it.each([
    ["guild_id", { guild_id: "100000000000000099" }],
    ["channel_id", { channel_id: "100000000000000099" }],
    ["id", { id: "100000000000000099" }],
  ])("rejects a source whose %s does not match", (_field, change) => {
    expect(() => decodeDiscordSourceMessage(source, {
      id: source.messageId,
      guild_id: source.guildId,
      channel_id: source.channelId,
      author: { id: "100000000000000004" },
      content: "source",
      type: 0,
      attachments: [],
      ...change,
    })).toThrow()
  })
})
