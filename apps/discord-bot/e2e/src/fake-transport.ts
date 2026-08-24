import type {
  ChannelSnapshot,
  MessageSnapshot,
  ResponseSnapshot,
  Snowflake,
  StagingTarget,
  ThreadSnapshot,
} from "./model.ts"
import type {
  DocsResult,
  E2ETransport,
  InteractionResult,
  OperatorResult,
} from "./transport.ts"

interface MutationCounts {
  createdMessages: number
  createdThreads: number
  createdResponses: number
  deletedMessages: number
  deletedThreads: number
  deletedResponses: number
}

export interface FakeWorld {
  readonly transport: E2ETransport
  readonly counts: MutationCounts
  readonly messages: ReadonlyMap<Snowflake, MessageSnapshot>
  readonly threads: ReadonlyMap<Snowflake, ThreadSnapshot>
  readonly responses: ReadonlyMap<Snowflake, ResponseSnapshot>
}

const isFiltered = (content: string): boolean => {
  const normalized = content.trim().toLocaleLowerCase("en")
  return normalized === "thanks" || normalized === "hello" || normalized === ""
}

export const makeFakeWorld = (target: StagingTarget): FakeWorld => {
  const messages = new Map<Snowflake, MessageSnapshot>()
  const threads = new Map<Snowflake, ThreadSnapshot>()
  const responses = new Map<Snowflake, ResponseSnapshot>()
  const pendingCreates = new Map<Snowflake, Promise<ThreadSnapshot>>()
  const counts: MutationCounts = {
    createdMessages: 0,
    createdThreads: 0,
    createdResponses: 0,
    deletedMessages: 0,
    deletedThreads: 0,
    deletedResponses: 0,
  }
  let nextId = 300_000_000_000_000_000n

  const id = (): Snowflake => String(nextId++) as Snowflake
  const response = (marker: string, hasAnswer: boolean, hasSources: boolean): ResponseSnapshot => {
    const value = { id: id(), channelId: target.channelId, marker, hasAnswer, hasSources }
    responses.set(value.id, value)
    counts.createdResponses += 1
    return value
  }
  const createThread = async (source: MessageSnapshot): Promise<ThreadSnapshot> => {
    const existing = threads.get(source.id)
    if (existing !== undefined) return existing

    const pending = pendingCreates.get(source.id)
    if (pending !== undefined) return pending

    const creating = Promise.resolve().then(() => {
      const thread = {
        id: source.id,
        guildId: target.guildId,
        parentChannelId: target.channelId,
        sourceMessageId: source.id,
        marker: source.marker,
      } satisfies ThreadSnapshot
      threads.set(source.id, thread)
      counts.createdThreads += 1
      pendingCreates.delete(source.id)
      return thread
    })
    pendingCreates.set(source.id, creating)
    return creating
  }

  const transport: E2ETransport = {
    inspectChannel: async (channelId): Promise<ChannelSnapshot> => ({
      id: channelId,
      guildId: target.guildId,
      topic: target.requiredTopicSentinel,
    }),
    createMessage: async ({ channelId, marker, content, author }) => {
      const message = { id: id(), channelId, marker, author } satisfies MessageSnapshot
      messages.set(message.id, message)
      counts.createdMessages += 1
      if (author === "human" && isFiltered(content) === false) await createThread(message)
      return message
    },
    findThreadForMessage: async (_guildId, sourceMessageId) => threads.get(sourceMessageId),
    operatorCreateThread: async ({ sourceMessageId }): Promise<OperatorResult> => {
      const source = messages.get(sourceMessageId)
      if (source === undefined) return { _tag: "Denied" }
      const existing = threads.get(sourceMessageId)
      if (existing !== undefined) return { _tag: "AlreadySatisfied", thread: existing }
      const wasPending = pendingCreates.has(sourceMessageId)
      const thread = await createThread(source)
      return wasPending === true
        ? { _tag: "AlreadySatisfied", thread }
        : { _tag: "Created", thread }
    },
    invokeMessageAction: async ({ sourceMessageId, marker, persona }): Promise<InteractionResult> => {
      const source = messages.get(sourceMessageId)
      if (persona !== "maintainer" || source === undefined) {
        return { _tag: "Denied", response: response(marker, false, false) }
      }
      return {
        _tag: "Created",
        thread: await createThread(source),
        response: response(marker, false, false),
      }
    },
    invokeDocs: async ({ marker, location, persona }): Promise<DocsResult> => {
      const authorized =
        location === "public" || persona === "contributor" || persona === "maintainer"
      return authorized === true
        ? { _tag: "Answered", response: response(marker, true, true) }
        : { _tag: "Denied", response: response(marker, false, false) }
    },
    deleteThread: async (threadId) => {
      if (threads.delete(threadId) === false) throw new Error("thread not found")
      counts.deletedThreads += 1
    },
    deleteMessage: async (_channelId, messageId) => {
      if (messages.delete(messageId) === false) throw new Error("message not found")
      counts.deletedMessages += 1
    },
    deleteResponse: async (responseId) => {
      if (responses.delete(responseId) === false) throw new Error("response not found")
      counts.deletedResponses += 1
    },
  }

  return { transport, counts, messages, threads, responses }
}
