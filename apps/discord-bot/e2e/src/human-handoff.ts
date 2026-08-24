import type { CommandRunner } from "./dfx-live-transport.ts"
import type { MessageSnapshot, ResponseSnapshot, Snowflake, ThreadSnapshot } from "./model.ts"
import { E2EPrerequisiteUnavailableError, type DocsResult, type InteractionResult } from "./transport.ts"

export interface HumanHandoffBroker {
  readonly createMessage: (input: {
    readonly channelId: Snowflake
    readonly marker: string
    readonly content: string
  }) => Promise<MessageSnapshot>
  readonly invokeMessageAction: (input: {
    readonly sourceMessageId: Snowflake
    readonly marker: string
    readonly persona: "maintainer" | "member"
  }) => Promise<InteractionResult>
  readonly invokeDocs: (input: {
    readonly marker: string
    readonly query: string
    readonly location: "public" | "restricted"
    readonly persona: "maintainer" | "contributor" | "member"
  }) => Promise<DocsResult>
  readonly deleteMessage: (message: MessageSnapshot) => Promise<void>
  readonly deleteResponse: (response: ResponseSnapshot) => Promise<void>
}

/**
 * Delegates Discord user-only gestures to an explicitly configured, attended
 * broker. The broker may pause for a human; it must never log in as a user bot.
 */
export const makeCommandHumanHandoffBroker = (input: {
  readonly executable: string
  readonly runCommand: CommandRunner
}): HumanHandoffBroker => {
  const request = async (operation: string, payload: object): Promise<unknown> => {
    const result = await input.runCommand(input.executable, [operation, "--request-json", JSON.stringify(payload)])
    if (result.exitCode === 7) {
      throw new E2EPrerequisiteUnavailableError("No human accepted the handoff request")
    }
    if (result.exitCode !== 0) throw new Error(`Human handoff broker exited ${result.exitCode}`)
    try {
      return result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout)
    } catch {
      throw new Error("Human handoff broker returned invalid JSON")
    }
  }

  return {
    createMessage: async (payload) => message(await request("create-message", payload)),
    invokeMessageAction: async (payload) => interaction(await request("invoke-message-action", payload)),
    invokeDocs: async (payload) => docs(await request("invoke-docs", payload)),
    deleteMessage: async (message) => {
      deleted(await request("delete-message", message), message.id)
    },
    deleteResponse: async (response) => {
      deleted(await request("delete-response", response), response.id)
    },
  }
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Human handoff broker returned invalid ${label}`)
  }
  return value as Record<string, unknown>
}

const attended = (decoded: Record<string, unknown>, label: string): void => {
  if (decoded.attendedByHuman !== true) {
    throw new E2EPrerequisiteUnavailableError(
      `Human handoff broker did not attest an attended ${label}`,
    )
  }
}

const snowflake = (value: unknown, label: string): Snowflake => {
  if (typeof value !== "string" || !/^\d{17,20}$/u.test(value)) {
    throw new Error(`Human handoff broker returned invalid ${label}`)
  }
  return value as Snowflake
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`Human handoff broker returned invalid ${label}`)
  return value
}

const message = (value: unknown): MessageSnapshot => {
  const decoded = record(value, "message")
  attended(decoded, "message action")
  return {
    id: snowflake(decoded.id, "message id"),
    channelId: snowflake(decoded.channelId, "message channel"),
    marker: text(decoded.marker, "message marker"),
    author: "human",
  }
}

const response = (value: unknown): ResponseSnapshot => {
  const decoded = record(value, "response")
  if (typeof decoded.hasAnswer !== "boolean" || typeof decoded.hasSources !== "boolean") {
    throw new Error("Human handoff broker returned invalid response assertions")
  }
  return {
    id: snowflake(decoded.id, "response id"),
    channelId: snowflake(decoded.channelId, "response channel"),
    marker: text(decoded.marker, "response marker"),
    hasAnswer: decoded.hasAnswer,
    hasSources: decoded.hasSources,
  }
}

const thread = (value: unknown): ThreadSnapshot => {
  const decoded = record(value, "thread")
  return {
    id: snowflake(decoded.id, "thread id"),
    guildId: snowflake(decoded.guildId, "thread guild"),
    parentChannelId: snowflake(decoded.parentChannelId, "thread parent channel"),
    sourceMessageId: snowflake(decoded.sourceMessageId, "thread source message"),
    marker: text(decoded.marker, "thread marker"),
  }
}

const interaction = (value: unknown): InteractionResult => {
  const decoded = record(value, "message action")
  attended(decoded, "message action")
  if (decoded._tag === "Denied") return { _tag: "Denied", response: response(decoded.response) }
  if (decoded._tag === "Created") {
    return { _tag: "Created", thread: thread(decoded.thread), response: response(decoded.response) }
  }
  throw new Error("Human handoff broker returned invalid message action tag")
}

const docs = (value: unknown): DocsResult => {
  const decoded = record(value, "docs result")
  attended(decoded, "docs command")
  if (decoded._tag !== "Answered" && decoded._tag !== "Denied") {
    throw new Error("Human handoff broker returned invalid docs tag")
  }
  return { _tag: decoded._tag, response: response(decoded.response) }
}

const deleted = (value: unknown, expectedId: Snowflake): void => {
  const decoded = record(value, "cleanup result")
  attended(decoded, "cleanup")
  if (decoded.deleted !== true || snowflake(decoded.id, "cleanup id") !== expectedId) {
    throw new Error("Human handoff broker did not confirm correlated cleanup")
  }
}
