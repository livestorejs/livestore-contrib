import type {
  ChannelSnapshot,
  MessageSnapshot,
  ResponseSnapshot,
  Snowflake,
  ThreadSnapshot,
} from "./model.ts"

export class E2EPrerequisiteUnavailableError extends Error {
  readonly name = "E2EPrerequisiteUnavailableError"
}

export type OperatorResult =
  | { readonly _tag: "Created"; readonly thread: ThreadSnapshot }
  | { readonly _tag: "AlreadySatisfied"; readonly thread: ThreadSnapshot }
  | { readonly _tag: "Denied" }

export type InteractionResult =
  | { readonly _tag: "Created"; readonly thread: ThreadSnapshot; readonly response: ResponseSnapshot }
  | { readonly _tag: "Denied"; readonly response: ResponseSnapshot }

export type DocsResult =
  | { readonly _tag: "Answered"; readonly response: ResponseSnapshot }
  | { readonly _tag: "Denied"; readonly response: ResponseSnapshot }

/**
 * Black-box surface shared by the in-memory tracer and live-staging adapters.
 * It deliberately describes observable operations instead of application internals.
 */
export interface E2ETransport {
  readonly inspectChannel: (channelId: Snowflake) => Promise<ChannelSnapshot>
  readonly createMessage: (input: {
    readonly channelId: Snowflake
    readonly marker: string
    readonly content: string
    readonly author: "human" | "automated-actor"
  }) => Promise<MessageSnapshot>
  readonly findThreadForMessage: (
    guildId: Snowflake,
    sourceMessageId: Snowflake,
  ) => Promise<ThreadSnapshot | undefined>
  readonly operatorCreateThread: (input: {
    readonly sourceMessageId: Snowflake
    readonly reason: string
  }) => Promise<OperatorResult>
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
  readonly deleteThread: (threadId: Snowflake) => Promise<void>
  readonly deleteMessage: (channelId: Snowflake, messageId: Snowflake) => Promise<void>
  readonly deleteResponse: (responseId: Snowflake) => Promise<void>
}
