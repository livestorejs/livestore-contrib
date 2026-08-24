import { describe, expect, it } from "vitest"
import { parseLiveManifest } from "./live-manifest.ts"
import { topicSentinel } from "./model.ts"

const valid = {
  schemaVersion: 1,
  environment: "staging",
  actorBotTokenRef: "op://LiveStore/Discord staging actor/token",
  botControlSocket: "/run/discord-bot/staging/control.sock",
  target: {
    guildId: "111111111111111111",
    channelId: "222222222222222222",
    allowedChannelIds: ["222222222222222222"],
    requiredTopicSentinel: topicSentinel,
    pollIntervalMs: 1_000,
    timeoutMs: 30_000,
  },
}

describe("live staging manifest", () => {
  it("accepts a staging-only, allowlisted manifest with credential indirection", () => {
    const manifest = parseLiveManifest(valid)
    expect(manifest.environment).toBe("staging")
    expect(manifest.target.allowedChannelIds.has(manifest.target.channelId)).toBe(true)
  })

  it.each([
    ["production target", { ...valid, environment: "production" }],
    ["inline credential", { ...valid, actorBotTokenRef: "raw-token" }],
    [
      "non-allowlisted channel",
      { ...valid, target: { ...valid.target, allowedChannelIds: [] } },
    ],
    [
      "wrong topic sentinel",
      { ...valid, target: { ...valid.target, requiredTopicSentinel: "general" } },
    ],
    ["production socket", { ...valid, botControlSocket: "/run/discord-bot/prod/control.sock" }],
    ["socket traversal", { ...valid, botControlSocket: "/run/discord-bot/staging/../production/control.sock" }],
    ["non-socket endpoint", { ...valid, botControlSocket: "/run/discord-bot/staging/control" }],
    ["unknown root field", { ...valid, inlineToken: "secret" }],
    ["unknown target field", { ...valid, target: { ...valid.target, channelName: "e2e" } }],
  ])("rejects %s", (_label, manifest) => {
    expect(() => parseLiveManifest(manifest)).toThrow()
  })
})
