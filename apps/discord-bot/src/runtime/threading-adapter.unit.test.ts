import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { DiscordMessageRef, EnvironmentName } from "../threading/model.ts"
import { candidateForOperator, makeDfxOperatorSourceReader } from "./threading-adapter.ts"

const source = Schema.decodeUnknownSync(DiscordMessageRef)({
  guildId: "100000000000000001",
  channelId: "100000000000000002",
  messageId: "100000000000000003",
})

describe("operator source validation", () => {
  it.effect("builds the operator candidate only from the exact fetched Discord message", () =>
    Effect.gen(function* () {
      const reader = makeDfxOperatorSourceReader({
        getMessage: () => Effect.succeed({
          id: source.messageId,
          guild_id: source.guildId,
          channel_id: source.channelId,
          author: { id: "100000000000000004" },
          content: "A real fetched source",
          type: 0,
          attachments: [{}],
          sticker_items: [{}],
          poll: {},
        }),
      })
      const facts = yield* reader.read(source)
      const candidate = candidateForOperator(
        source,
        Schema.decodeUnknownSync(EnvironmentName)("staging"),
        undefined,
        "incident repair",
        "unix-peer:uid=42",
        true,
        facts,
      )

      expect(candidate).toMatchObject({
        content: "A real fetched source",
        authorKind: "Human",
        attachmentCount: 1,
        hasPoll: true,
        stickerCount: 1,
        trigger: { principal: "unix-peer:uid=42", authorized: true },
      })
    }),
  )

  it.effect("rejects a response that is not anchored to the requested message", () =>
    Effect.gen(function* () {
      const reader = makeDfxOperatorSourceReader({
        getMessage: () => Effect.succeed({
          id: "100000000000000099",
          guild_id: source.guildId,
          channel_id: source.channelId,
          author: { id: "100000000000000004" },
          content: "wrong message",
          type: 0,
          attachments: [],
        }),
      })
      const failure = yield* Effect.flip(reader.read(source))
      expect(failure).toMatchObject({ _tag: "OperatorSourceReadError", kind: "invalid_source" })
    }),
  )
})
