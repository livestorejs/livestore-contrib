import { describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { expect } from "vitest"
import { classifyContent, evaluateAutomaticThread, type AutomaticThreadPolicyConfig } from "./eligibility.ts"
import { DiscordSnowflake, EnvironmentName, ThreadCandidate, type AutomaticRejectionReason } from "./model.ts"

const config: AutomaticThreadPolicyConfig = {
  environment: "staging",
  guildId: "10000000000000001",
  parentChannelIds: new Set(["10000000000000002"]),
  admittedParentKinds: new Set(["GuildText", "GuildAnnouncement"]),
  legacyCommands: new Set(["!help", "!ping"]),
}

const candidate = Schema.decodeUnknownSync(ThreadCandidate)({
  environment: "staging",
  source: {
    guildId: "10000000000000001",
    channelId: "10000000000000002",
    messageId: "10000000000000003",
  },
  sourceChannelKind: "GuildText",
  messageKind: "Default",
  hasMessageReference: false,
  authorKind: "Human",
  content: "Sync bug?",
  attachmentCount: 0,
  hasPoll: false,
  stickerCount: 0,
  trigger: { _tag: "Automatic", deliveryCorrelation: "session:1" },
})
const existingThreadId = Schema.decodeUnknownSync(DiscordSnowflake)("10000000000000004")
const otherSnowflake = Schema.decodeUnknownSync(DiscordSnowflake)("10000000000000009")
const production = Schema.decodeUnknownSync(EnvironmentName)("production")

describe("automatic thread eligibility", () => {
  const cases: ReadonlyArray<readonly [string, Partial<typeof candidate>, "Eligible" | AutomaticRejectionReason]> = [
    ["baseline", {}, "Eligible"],
    ["wrong environment", { environment: production }, "wrong_environment"],
    ["wrong guild", { source: { ...candidate.source, guildId: otherSnowflake } }, "wrong_guild"],
    ["unconfigured parent", { source: { ...candidate.source, channelId: otherSnowflake } }, "parent_channel_not_configured"],
    ["thread source", { sourceChannelKind: "PublicThread" }, "source_is_thread_or_dm"],
    ["reply", { messageKind: "Reply" }, "reply"],
    ["system message", { messageKind: "System" }, "non_ordinary_message"],
    ["bot", { authorKind: "Bot" }, "bot_author"],
    ["webhook", { authorKind: "Webhook" }, "webhook_author"],
    ["application", { authorKind: "Application" }, "application_author"],
    ["existing thread", { existingThreadId }, "existing_thread"],
  ]

  for (const [label, patch, expected] of cases) {
    it(label, () => {
      const decision = evaluateAutomaticThread({ ...candidate, ...patch }, config)
      expect(decision._tag === "Eligible" ? "Eligible" : decision.reason).toBe(expected)
    })
  }

  it("keeps structural rejection ahead of every content rejection", () => {
    const contents = ["", "hello", "thanks", "!help", "https://example.test", "123", "🎉"]
    for (const content of contents) {
      expect(evaluateAutomaticThread({ ...candidate, environment: production, content }, config)).toEqual({
        _tag: "Rejected",
        reason: "wrong_environment",
      })
    }
  })

  it("retains bounded low-information filters without suppressing substantive counterexamples", () => {
    const rejected = new Map<string, AutomaticRejectionReason>([
      ["  HELLO!!!\n", "greeting"],
      ["Thanks...", "reaction"],
      ["!help sync", "recognized_command"],
      ["https://example.test", "url_only"],
      ["v1.2.3-beta.1", "numeric_or_version_only"],
      ["👍🏽!", "reaction_symbols_only"],
    ])
    for (const [content, reason] of rejected) {
      expect(classifyContent({ content, attachmentCount: 0, hasPoll: false, stickerCount: 0 }, config)).toBe(reason)
    }

    for (const content of [
      "Why CRDT?",
      "Sync bug?",
      "Need help 🚨",
      "hello, sync is broken",
      "Context: https://example.test",
      "!important regression",
    ]) {
      expect(evaluateAutomaticThread({ ...candidate, content }, config)).toEqual({ _tag: "Eligible" })
    }
  })

  it("admits attachment-only and poll-only messages", () => {
    expect(classifyContent({ content: "", attachmentCount: 1, hasPoll: false, stickerCount: 0 }, config)).toBeUndefined()
    expect(classifyContent({ content: "", attachmentCount: 0, hasPoll: true, stickerCount: 0 }, config)).toBeUndefined()
  })
})
