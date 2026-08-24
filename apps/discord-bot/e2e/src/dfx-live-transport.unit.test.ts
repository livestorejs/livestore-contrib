import { describe, expect, it } from "vitest"
import { operatorCreateThreadArguments } from "./dfx-live-transport.ts"
import { topicSentinel, type Snowflake, type StagingTarget } from "./model.ts"

const target: StagingTarget = {
  guildId: "111111111111111111" as Snowflake,
  channelId: "222222222222222222" as Snowflake,
  allowedChannelIds: new Set(["222222222222222222" as Snowflake]),
  requiredTopicSentinel: topicSentinel,
  pollIntervalMs: 1,
  timeoutMs: 4,
}

describe("DFX live transport operator boundary", () => {
  it("routes every control request through the exact manifest socket", () => {
    const args = operatorCreateThreadArguments({
      target,
      sourceMessageId: "333333333333333333" as Snowflake,
      reason: "correlated test",
      botControlSocket: "/run/discord-bot/staging/isolated.sock",
    })

    expect(args).toContain("--socket")
    expect(args[args.indexOf("--socket") + 1]).toBe("/run/discord-bot/staging/isolated.sock")
    expect(args).not.toContain("/run/discord-bot/control.sock")
  })
})
