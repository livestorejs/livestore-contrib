import { NodeHttpClient } from '@effect/platform-node'
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import {
  DiscordRestFailure,
  discordSafeLoggerLayer,
  redactDiscordRestCause,
} from '../../src/discord/rest-error-redaction.ts'
import { CleanupArtifactNotFoundError } from './cleanup-ledger.ts'
import type { ChannelSnapshot, Snowflake, ThreadSnapshot } from './model.ts'
import { E2EPrerequisiteUnavailableError, type E2ETransport } from './transport.ts'

export interface RecoveryDiscordApi {
  readonly getChannel: (channelId: Snowflake) => Promise<unknown>
  readonly listMessages?: (channelId: Snowflake, before?: Snowflake) => Promise<unknown>
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
  if (error instanceof DiscordRestFailure) return error.status === 404
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
export interface RecoveryTransport extends E2ETransport {
  readonly findMessageByMarker: (channelId: Snowflake, marker: string) => Promise<Snowflake | undefined>
}

export const makeRecoveryTransport = (discord: RecoveryDiscordApi): RecoveryTransport => ({
  findMessageByMarker: async (channelId, marker) => {
    if (discord.listMessages === undefined) throw new Error('Recovery message listing is unavailable')
    let before: Snowflake | undefined
    let match: Snowflake | undefined
    for (;;) {
      const page = await discord.listMessages(channelId, before)
      if (Array.isArray(page) === false) throw new Error('Recovery message listing was invalid')
      for (const raw of page) {
        const message = asRecord(raw, 'recover-message')
        const id = asSnowflake(message.id, 'recover-message')
        if (
          message.channel_id === channelId &&
          typeof message.content === 'string' &&
          message.content.includes(marker) === true
        ) {
          const author = asRecord(message.author, 'recover-author')
          if (author.bot === false || author.bot === undefined) {
            if (match !== undefined && match !== id) throw new Error('Multiple human messages match cleanup marker')
            match = id
          }
        }
        before = id
      }
      if (page.length < 100) return match
    }
  },
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
}): RecoveryTransport & { readonly dispose: () => Promise<void> } => {
  const DiscordLive = DiscordRESTMemoryLive.pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(DiscordConfig.layer({ token: Redacted.make(input.actorBotToken) })),
  )
  const runtime = ManagedRuntime.make(Layer.merge(DiscordLive, discordSafeLoggerLayer))
  const rest = <A, E>(effect: Effect.Effect<A, E, DiscordREST>): Promise<A> =>
    runtime.runPromise(effect.pipe(Effect.catchCause((cause) => Effect.fail(redactDiscordRestCause(cause)))))
  const transport = makeRecoveryTransport({
    getChannel: (channelId) => rest(Effect.flatMap(DiscordREST, (discord) => discord.getChannel(channelId))),
    listMessages: (channelId, before) =>
      rest(Effect.flatMap(DiscordREST, (discord) => discord.listMessages(channelId, { limit: 100, before }))),
    deleteChannel: async (channelId) => {
      await rest(Effect.flatMap(DiscordREST, (discord) => discord.deleteChannel(channelId)))
    },
    deleteMessage: async (channelId, messageId) => {
      await rest(Effect.flatMap(DiscordREST, (discord) => discord.deleteMessage(channelId, messageId)))
    },
  })
  return Object.assign(transport, { dispose: () => runtime.dispose() })
}
