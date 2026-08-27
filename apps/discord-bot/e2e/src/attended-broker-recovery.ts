import { NodeHttpClient } from '@effect/platform-node'
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import { CleanupArtifactNotFoundError } from './cleanup-ledger.ts'
import type { ChannelSnapshot, Snowflake, ThreadSnapshot } from './model.ts'
import { E2EPrerequisiteUnavailableError, type E2ETransport } from './transport.ts'

export interface RecoveryDiscordApi {
  readonly getChannel: (channelId: Snowflake) => Promise<unknown>
  readonly deleteChannel: (channelId: Snowflake) => Promise<void>
  readonly deleteMessage: (channelId: Snowflake, messageId: Snowflake) => Promise<void>
}

const asSnowflake = (value: unknown, label: string): Snowflake => {
  if (typeof value !== 'string' || /^\d{17,20}$/u.test(value) === false) {
    throw new Error(`broker ${label} returned an invalid snowflake`)
  }
  return value as Snowflake
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) {
    throw new Error(`broker ${label} returned an invalid channel`)
  }
  return value as Record<string, unknown>
}

const isNotFound = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('response' in error)) return false
  const response = error.response
  return typeof response === 'object' && response !== null && 'status' in response && response.status === 404
}

const translateNotFound = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (error) {
    if (isNotFound(error) === true) throw new CleanupArtifactNotFoundError('Discord artifact is already gone')
    throw error
  }
}

/** Exact-ID recovery seam; getChannel also sees archived and private threads. */
export const makeRecoveryTransport = (discord: RecoveryDiscordApi): E2ETransport => ({
  inspectChannel: async (channelId): Promise<ChannelSnapshot> => {
    const channel = asRecord(await translateNotFound(() => discord.getChannel(channelId)), 'recover-inspect')
    return {
      id: asSnowflake(channel.id, 'recover-inspect'),
      guildId: asSnowflake(channel.guild_id, 'recover-inspect'),
      topic: typeof channel.topic === 'string' ? channel.topic : undefined,
    }
  },
  createMessage: async () => {
    throw new E2EPrerequisiteUnavailableError('recovery transport never creates messages')
  },
  findThreadForMessage: async (_guildId, threadId): Promise<ThreadSnapshot | undefined> => {
    let value: unknown
    try {
      value = await discord.getChannel(threadId)
    } catch (error) {
      if (isNotFound(error) === true) return undefined
      throw error
    }
    const channel = asRecord(value, 'recover-thread')
    if (channel.type !== 10 && channel.type !== 11 && channel.type !== 12) {
      throw new Error(`Cleanup ledger artifact ${threadId} is not a Discord thread`)
    }
    return {
      id: asSnowflake(channel.id, 'recover-thread'),
      guildId: asSnowflake(channel.guild_id, 'recover-thread'),
      parentChannelId: asSnowflake(channel.parent_id, 'recover-thread'),
      sourceMessageId: threadId,
      marker: '',
    }
  },
  operatorCreateThread: async () => {
    throw new E2EPrerequisiteUnavailableError('recovery transport never creates threads')
  },
  invokeMessageAction: async () => {
    throw new E2EPrerequisiteUnavailableError('recovery transport never invokes actions')
  },
  invokeDocs: async () => {
    throw new E2EPrerequisiteUnavailableError('recovery transport never invokes docs')
  },
  deleteThread: (threadId) => translateNotFound(() => discord.deleteChannel(threadId)),
  deleteMessage: (channelId, messageId) => translateNotFound(() => discord.deleteMessage(channelId, messageId)),
  deleteResponse: (channelId, responseId) => translateNotFound(() => discord.deleteMessage(channelId, responseId)),
})

export const makeDfxRecoveryTransport = (input: {
  readonly actorBotToken: string
}): E2ETransport & { readonly dispose: () => Promise<void> } => {
  const DiscordLive = DiscordRESTMemoryLive.pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(DiscordConfig.layer({ token: Redacted.make(input.actorBotToken) })),
  )
  const runtime = ManagedRuntime.make(DiscordLive)
  const rest = <A, E>(effect: Effect.Effect<A, E, DiscordREST>): Promise<A> => runtime.runPromise(effect)
  const transport = makeRecoveryTransport({
    getChannel: (channelId) => rest(Effect.flatMap(DiscordREST, (discord) => discord.getChannel(channelId))),
    deleteChannel: async (channelId) => {
      await rest(Effect.flatMap(DiscordREST, (discord) => discord.deleteChannel(channelId)))
    },
    deleteMessage: async (channelId, messageId) => {
      await rest(Effect.flatMap(DiscordREST, (discord) => discord.deleteMessage(channelId, messageId)))
    },
  })
  return Object.assign(transport, { dispose: () => runtime.dispose() })
}
