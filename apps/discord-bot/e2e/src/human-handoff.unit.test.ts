import { describe, expect, it, vi } from "vitest"
import { makeCommandHumanHandoffBroker } from "./human-handoff.ts"
import type { Snowflake } from "./model.ts"

describe("attended human handoff broker", () => {
  it("uses an explicit executable and decodes a human-owned message", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "333333333333333333",
        channelId: "222222222222222222",
        marker: "marker",
        attendedByHuman: true,
      }),
      stderr: "",
    }))
    const broker = makeCommandHumanHandoffBroker({ executable: "/opt/e2e/human-broker", runCommand })

    await expect(broker.createMessage({
      channelId: "222222222222222222" as Snowflake,
      marker: "marker",
      content: "question",
    })).resolves.toEqual(expect.objectContaining({ author: "human" }))
    expect(runCommand).toHaveBeenCalledWith(
      "/opt/e2e/human-broker",
      ["create-message", "--request-json", expect.any(String)],
    )
  })

  it("maps an unavailable human to a prerequisite instead of PASS", async () => {
    const broker = makeCommandHumanHandoffBroker({
      executable: "/opt/e2e/human-broker",
      runCommand: async () => ({ exitCode: 7, stdout: "", stderr: "no human" }),
    })
    await expect(broker.createMessage({
      channelId: "222222222222222222" as Snowflake,
      marker: "marker",
      content: "question",
    })).rejects.toMatchObject({ name: "E2EPrerequisiteUnavailableError" })
  })

  it("rejects an un-attested executable result as unavailable", async () => {
    const broker = makeCommandHumanHandoffBroker({
      executable: "/opt/e2e/not-attended",
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          id: "333333333333333333",
          channelId: "222222222222222222",
          marker: "marker",
        }),
        stderr: "",
      }),
    })
    await expect(broker.createMessage({
      channelId: "222222222222222222" as Snowflake,
      marker: "marker",
      content: "question",
    })).rejects.toMatchObject({ name: "E2EPrerequisiteUnavailableError" })
  })

  it("requires attended, ID-correlated cleanup confirmation", async () => {
    const broker = makeCommandHumanHandoffBroker({
      executable: "/opt/e2e/human-broker",
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          attendedByHuman: true,
          deleted: true,
          id: "999999999999999999",
        }),
        stderr: "",
      }),
    })
    await expect(broker.deleteMessage({
      id: "333333333333333333" as Snowflake,
      channelId: "222222222222222222" as Snowflake,
      marker: "marker",
      author: "human",
    })).rejects.toThrow("correlated cleanup")
  })
})
