import { execFile } from 'node:child_process'

import { NodeHttpClient } from '@effect/platform-node'
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import { makeHttpsBotControlClient } from './admin-http-client.ts'
import type {
  ChannelSnapshot,
  MessageSnapshot,
  ResponseSnapshot,
  Snowflake,
  StagingTarget,
  ThreadSnapshot,
} from './model.ts'
import { E2EPrerequisiteUnavailableError, type E2ETransport, type OperatorResult } from './transport.ts'

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (executable: string, args: ReadonlyArray<string>) => Promise<CommandResult>

export interface DfxLiveTransportInput {
  /** Resolved only in process by the approved op-proxy invocation. */
  readonly actorBotToken: string
  readonly target: StagingTarget
  /** Exact staging control socket admitted by the manifest; absent with botAdminEndpoint. */
  readonly botControlSocket?: string
  /**
   * Present with adminToken: the operator lane crosses the authenticated HTTPS
   * admin plane instead of the control socket + CLI executable.
   */
  readonly botAdminEndpoint?: string
  /** Resolved only from LIVESTORE_DISCORD_ADMIN_TOKEN by the entrypoint wiring. */
  readonly adminToken?: string
  readonly cliExecutable?: string
  readonly runCommand?: CommandRunner
  /** Human-assisted fixture provider; never implemented with a user token. */
  readonly createHumanMessage?: (input: {
    readonly channelId: Snowflake
    readonly marker: string
    readonly content: string
  }) => Promise<MessageSnapshot>
  readonly invokeMessageAction?: E2ETransport['invokeMessageAction']
  readonly invokeDocs?: E2ETransport['invokeDocs']
  readonly deleteHumanResponse?: (response: ResponseSnapshot) => Promise<void>
  readonly deleteHumanMessage?: (message: MessageSnapshot) => Promise<void>
}

export interface DfxLiveTransport {
  readonly transport: E2ETransport
  readonly dispose: () => Promise<void>
}

export const defaultRunCommand: CommandRunner = (executable, args) =>
  new Promise((resolve) => {
    execFile(executable, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr,
      })
    })
  })

const asSnowflake = (value: string, operation: string): Snowflake => {
  if (/^\d{17,20}$/u.test(value) === false) throw new Error(`${operation} returned an invalid snowflake`)
  return value as Snowflake
}

const parseControlResult = (result: CommandResult): 'Created' | 'AlreadySatisfied' => {
  if (result.exitCode !== 0) {
    throw new Error(`Bot control CLI exited ${result.exitCode}: ${result.stderr.trim()}`)
  }
  const decoded: unknown = JSON.parse(result.stdout)
  if (typeof decoded !== 'object' || decoded === null || !('_tag' in decoded)) {
    throw new Error('Bot control CLI returned an invalid JSON result')
  }
  const tag = (decoded as { readonly _tag: unknown })._tag
  if (tag === 'Success') return 'Created'
  if (tag === 'AlreadySatisfied') return 'AlreadySatisfied'
  throw new Error(`Bot control CLI returned unexpected result ${String(tag)}`)
}

export const operatorCreateThreadArguments = (input: {
  readonly target: StagingTarget
  readonly sourceMessageId: Snowflake
  readonly reason: string
  readonly botControlSocket?: string
}): ReadonlyArray<string> => [
  'thread',
  'create',
  `https://discord.com/channels/${input.target.guildId}/${input.target.channelId}/${input.sourceMessageId}`,
  '--environment',
  'staging',
  ...(input.botControlSocket === undefined ? [] : ['--socket', input.botControlSocket]),
  '--apply',
  '--reason',
  input.reason,
  '--output',
  'json',
]

/**
 * DFX owns every Discord REST call; the operator lane crosses the public CLI
 * boundary and then verifies its effect independently through Discord REST.
 */
export const makeDfxLiveTransport = (input: DfxLiveTransportInput): DfxLiveTransport => {
  const DiscordLive = DiscordRESTMemoryLive.pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(DiscordConfig.layer({ token: Redacted.make(input.actorBotToken) })),
  )
  const runtime = ManagedRuntime.make(DiscordLive)
  const sourceMarkers = new Map<Snowflake, string>()
  const sourceAuthors = new Map<Snowflake, MessageSnapshot['author']>()
  const sources = new Map<Snowflake, MessageSnapshot>()
  const responses = new Map<Snowflake, ResponseSnapshot>()
  const runCommand = input.runCommand ?? defaultRunCommand
  const cliExecutable = input.cliExecutable ?? 'livestore-discord'
  const adminClient =
    input.botAdminEndpoint === undefined || input.adminToken === undefined
      ? undefined
      : makeHttpsBotControlClient({ endpoint: input.botAdminEndpoint, adminToken: input.adminToken })
  const rest = <A, E>(effect: Effect.Effect<A, E, DiscordREST>): Promise<A> => runtime.runPromise(effect)

  const findThread = async (guildId: Snowflake, sourceMessageId: Snowflake): Promise<ThreadSnapshot | undefined> => {
    const response = await rest(Effect.flatMap(DiscordREST, (discord) => discord.getActiveGuildThreads(guildId)))
    const candidate = response.threads.find((thread) => thread.id === sourceMessageId)
    if (candidate === undefined || candidate.guild_id == null || candidate.parent_id == null) {
      return undefined
    }
    return {
      id: asSnowflake(candidate.id, 'find-thread'),
      guildId: asSnowflake(candidate.guild_id, 'find-thread'),
      parentChannelId: asSnowflake(candidate.parent_id, 'find-thread'),
      sourceMessageId,
      marker: sourceMarkers.get(sourceMessageId) ?? '',
    }
  }

  const awaitThread = async (sourceMessageId: Snowflake): Promise<ThreadSnapshot> => {
    const deadline = Date.now() + input.target.timeoutMs
    while (Date.now() < deadline) {
      const thread = await findThread(input.target.guildId, sourceMessageId)
      if (thread !== undefined) return thread
      await new Promise<void>((resolve) => setTimeout(resolve, input.target.pollIntervalMs))
    }
    throw new Error('Bot control CLI succeeded but no correlated Discord thread appeared')
  }

  const transport: E2ETransport = {
    inspectChannel: async (channelId): Promise<ChannelSnapshot> => {
      const channel = await rest(Effect.flatMap(DiscordREST, (discord) => discord.getChannel(channelId)))
      if (!('guild_id' in channel) || channel.guild_id === undefined) {
        throw new Error('E2E target is not a guild channel')
      }
      return {
        id: asSnowflake(channel.id, 'inspect-channel'),
        guildId: asSnowflake(channel.guild_id, 'inspect-channel'),
        topic: 'topic' in channel && typeof channel.topic === 'string' ? channel.topic : undefined,
      }
    },
    createMessage: async ({ channelId, marker, content, author }): Promise<MessageSnapshot> => {
      if (author === 'human') {
        if (input.createHumanMessage === undefined) {
          throw new E2EPrerequisiteUnavailableError('A human-authored staging source fixture is required')
        }
        const snapshot = await input.createHumanMessage({ channelId, marker, content })
        sourceMarkers.set(snapshot.id, marker)
        sourceAuthors.set(snapshot.id, snapshot.author)
        sources.set(snapshot.id, snapshot)
        return snapshot
      }
      const message = await rest(
        Effect.flatMap(DiscordREST, (discord) => discord.createMessage(channelId, { content })),
      )
      const snapshot = {
        id: asSnowflake(message.id, 'create-message'),
        channelId: asSnowflake(message.channel_id, 'create-message'),
        marker,
        author,
      } satisfies MessageSnapshot
      sourceMarkers.set(snapshot.id, marker)
      sourceAuthors.set(snapshot.id, author)
      sources.set(snapshot.id, snapshot)
      return snapshot
    },
    findThreadForMessage: findThread,
    operatorCreateThread: async ({ sourceMessageId, reason }): Promise<OperatorResult> => {
      const tag =
        adminClient === undefined
          ? parseControlResult(
              await runCommand(
                cliExecutable,
                operatorCreateThreadArguments({
                  target: input.target,
                  sourceMessageId,
                  reason,
                  ...(input.botControlSocket === undefined
                    ? {}
                    : { botControlSocket: input.botControlSocket }),
                }),
              ),
            )
          : await (async () => {
              const result = await adminClient.threadCreate({
                guildId: input.target.guildId,
                channelId: input.target.channelId,
                sourceMessageId,
                reason,
              })
              if (result._tag !== 'Success' && result._tag !== 'AlreadySatisfied') {
                throw new Error(`Bot control admin plane returned unexpected result ${result._tag}`)
              }
              return result._tag === 'Success' ? ('Created' as const) : ('AlreadySatisfied' as const)
            })()
      const thread = await awaitThread(sourceMessageId)
      return tag === 'Created' ? { _tag: 'Created', thread } : { _tag: 'AlreadySatisfied', thread }
    },
    invokeMessageAction: async (request) => {
      if (input.invokeMessageAction !== undefined) {
        const result = await input.invokeMessageAction(request)
        responses.set(result.response.id, result.response)
        return result
      }
      throw new E2EPrerequisiteUnavailableError('Discord has no official API for initiating a message-context action')
    },
    invokeDocs: async (request) => {
      if (input.invokeDocs !== undefined) {
        const result = await input.invokeDocs(request)
        for (const response of result.responses) responses.set(response.id, response)
        return result
      }
      throw new E2EPrerequisiteUnavailableError('Discord has no official API for initiating an application command')
    },
    deleteThread: async (threadId) => {
      await rest(Effect.flatMap(DiscordREST, (discord) => discord.deleteChannel(threadId)))
    },
    deleteMessage: async (channelId, messageId) => {
      if (sourceAuthors.get(messageId) === 'human') {
        if (input.deleteHumanMessage === undefined) {
          throw new E2EPrerequisiteUnavailableError('Human-authored source cleanup is not configured')
        }
        const source = sources.get(messageId)
        if (source === undefined || source.channelId !== channelId) {
          throw new Error('Human source cleanup lost its correlation record')
        }
        await input.deleteHumanMessage(source)
        sourceMarkers.delete(messageId)
        sourceAuthors.delete(messageId)
        sources.delete(messageId)
        return
      }
      await rest(Effect.flatMap(DiscordREST, (discord) => discord.deleteMessage(channelId, messageId)))
      sourceMarkers.delete(messageId)
      sourceAuthors.delete(messageId)
      sources.delete(messageId)
    },
    deleteResponse: async (responseId) => {
      if (input.deleteHumanResponse !== undefined) {
        const response = responses.get(responseId)
        if (response === undefined) throw new Error('Response cleanup lost its correlation record')
        await input.deleteHumanResponse(response)
        responses.delete(responseId)
        return
      }
      throw new E2EPrerequisiteUnavailableError('Human-assisted response cleanup is not configured')
    },
  }

  return { transport, dispose: () => runtime.dispose() }
}
