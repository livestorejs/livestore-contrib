import { Effect, Layer, Schema } from 'effect'

import {
  DiscordActions,
  DiscordEventHandlers,
  type AutomaticMessage,
  type CreateThreadInteraction,
  type DocsInteraction,
} from '../discord/index.ts'
// Selective imports: the docs barrel re-exports node-bound modules
// (admission/workflow crypto, file state store), which would drag `node:*`
// into node-free hosts that share this layer (Cloudflare worker). The config
// type comes from the portable schema module for the same reason.
import { renderDocsMessages } from '../docs/render.ts'
import { DocsWorkflow } from '../docs/services.ts'
import { EnvironmentName, type ThreadCandidate, type ThreadOutcome } from '../threading/index.ts'
import type { RuntimeConfigPayload } from './config-schema.ts'

const createPublicThreads = 1n << 35n
const useApplicationCommands = 1n << 31n

export interface RuntimeWorkflows {
  readonly thread: (candidate: ThreadCandidate) => Effect.Effect<ThreadOutcome>
  /** Resolves a channel's parent through Discord REST; absent in fake mode. */
  readonly resolveDocsChannelParent?: (input: {
    readonly guildId: string
    readonly channelId: string
  }) => Effect.Effect<{ readonly guildId: string; readonly parentChannelId?: string }, DocsChannelResolutionError>
  readonly docsReady?: boolean
}

export class DocsChannelResolutionError extends Schema.TaggedError<DocsChannelResolutionError>()(
  'DocsChannelResolutionError',
  { message: Schema.String },
) {}

export const makeDiscordEventHandlersLayer = (config: RuntimeConfigPayload, workflows: RuntimeWorkflows) =>
  Layer.effect(
    DiscordEventHandlers,
    Effect.gen(function* () {
      const actions = yield* DiscordActions
      const docs = yield* DocsWorkflow

      const onAutomaticMessage = Effect.fn('runtime.handlers.automaticMessage')(function* (input: AutomaticMessage) {
        yield* workflows.thread(toAutomaticCandidate(config, input))
        // Outcomes are content-free and intentionally not echoed into Discord.
      })

      const onCreateThreadInteraction = Effect.fn('runtime.handlers.createThreadInteraction')(function* (
        input: CreateThreadInteraction,
      ) {
        yield* actions.deferInteraction(input.route, 'ephemeral')
        const authorized =
          hasPermission(input.actor.effectivePermissions, createPublicThreads) &&
          hasPermission(input.applicationPermissions, createPublicThreads)
        const outcome = yield* workflows.thread({
          ...toAutomaticCandidate(config, input.sourceMessage),
          trigger: {
            _tag: 'DiscordManual',
            actorId: input.actor.userId,
            authorized,
            deliveryCorrelation: input.route.interactionId,
          },
        })
        yield* actions.editInteractionResponse({
          route: input.route,
          visibility: 'ephemeral',
          content: renderThreadOutcome(outcome),
        })
      })

      const onDocsInteraction = Effect.fn('runtime.handlers.docsInteraction')(function* (input: DocsInteraction) {
        const resolved =
          workflows.resolveDocsChannelParent === undefined
            ? Effect.succeed<{ readonly guildId: string; readonly parentChannelId?: string }>({
                guildId: input.guildId,
              })
            : workflows.resolveDocsChannelParent({ guildId: input.guildId, channelId: input.channelId }).pipe(
                Effect.orDie,
                Effect.catchCause(() => Effect.void),
              )
        const channel = yield* resolved
        const authorized =
          workflows.docsReady !== false &&
          channel !== undefined &&
          channel.guildId === config.guildId &&
          docsAuthorized(config, input, channel.parentChannelId) === true
        if (authorized === false) {
          yield* actions.respondInteraction({
            route: input.route,
            visibility: 'ephemeral',
            content: 'This channel or role is not configured for the documentation assistant.',
          })
          return
        }
        yield* actions.deferInteraction(input.route, 'public')
        const result = yield* docs.query({
          surface: 'discord',
          principalId: input.actor.userId,
          query: input.query,
        })
        const rendered = renderDocsMessages(result)
        if (rendered._tag === 'RenderingFailed') {
          yield* actions.editInteractionResponse({
            route: input.route,
            visibility: 'public',
            content: 'The documentation answer could not be rendered safely for Discord.',
          })
          return
        }
        yield* deliverDocsMessages(actions, input.route, rendered.messages)
      })

      return DiscordEventHandlers.of({
        onAutomaticMessage: (input) => safelyHandle(onAutomaticMessage(input).pipe(Effect.orDie)),
        onCreateThreadInteraction: (input) => safelyHandle(onCreateThreadInteraction(input).pipe(Effect.orDie)),
        onDocsInteraction: (input) => safelyHandle(onDocsInteraction(input).pipe(Effect.orDie)),
      })
    }),
  )

const toAutomaticCandidate = (config: RuntimeConfigPayload, input: AutomaticMessage): ThreadCandidate => ({
  environment: Schema.decodeUnknownSync(EnvironmentName)(config.environment),
  source: { guildId: input.guildId, channelId: input.channelId, messageId: input.messageId },
  sourceChannelKind: input.sourceChannelKind ?? 'GuildText',
  messageKind: input.isReply === true ? 'Reply' : input.authorIsSystem === true ? 'System' : 'Default',
  hasMessageReference: input.isReply,
  authorKind:
    input.authorIsBot === true
      ? 'Bot'
      : input.hasWebhookAuthor === true
        ? 'Webhook'
        : input.hasApplicationAuthor === true
          ? 'Application'
          : 'Human',
  existingThreadId: input.existingThreadId,
  content: input.content,
  attachmentCount: input.hasAttachments === true ? 1 : 0,
  hasPoll: input.hasPoll,
  stickerCount: 0,
  trigger: { _tag: 'Automatic', deliveryCorrelation: input.messageId },
})

const hasPermission = (encoded: string, permission: bigint) => {
  try {
    return (BigInt(encoded) & permission) === permission
  } catch {
    return false
  }
}

const docsAuthorized = (config: RuntimeConfigPayload, input: DocsInteraction, parentChannelId?: string) => {
  if (hasPermission(input.actor.effectivePermissions, useApplicationCommands) === false) return false
  if (hasPermission(input.applicationPermissions, useApplicationCommands) === false) return false
  const channelId = parentChannelId ?? input.channelId
  if (config.docsAudience.publicChannelIds.includes(channelId) === true) return true
  return (
    config.docsAudience.roleRestrictedChannelIds.includes(channelId) === true &&
    input.actor.roleIds.some((role) => config.docsAudience.contributorMaintainerRoleIds.includes(role)) === true
  )
}

const renderThreadOutcome = (outcome: ThreadOutcome): string => {
  switch (outcome._tag) {
    case 'Created':
      return `Created thread <#${outcome.threadId}>.`
    case 'AlreadySatisfied':
      return `A thread already exists: <#${outcome.threadId}>.`
    case 'AuthorizationRejected':
      return 'You do not have permission to create this thread.'
    case 'PolicyRejected':
      return `This message is not eligible (${outcome.reason}).`
    case 'TransientFailure':
      return `Thread creation is not safely complete (${outcome.failureCode}); an operator can reconcile it.`
    case 'TerminalFailure':
      return `Thread creation failed (${outcome.failureCode}).`
  }
}

/** The Gateway callback cannot fail; report a content-free failure and keep serving. */
const safelyHandle = (effect: Effect.Effect<void, never>) =>
  effect.pipe(
    Effect.catchCause(() => Effect.logError('Discord event handler failed')),
    Effect.orDie,
  )

/** Delivers one public initial response followed by ordered public messages. */
export const deliverDocsMessages = (
  actions: typeof DiscordActions.Service,
  route: DocsInteraction['route'],
  messages: readonly [string, ...ReadonlyArray<string>],
) =>
  Effect.suspend(() => {
    let lastSuccessfulOrdinal = 0
    return Effect.gen(function* () {
      const deliver = (content: string, followUp: boolean) =>
        (followUp === true
          ? actions.followUpInteractionResponse({ route, visibility: 'public', content })
          : actions.editInteractionResponse({ route, visibility: 'public', content })
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              lastSuccessfulOrdinal += 1
            }),
          ),
        )

      yield* deliver(messages[0], false)
      for (const message of messages.slice(1)) yield* deliver(message, true)
    }).pipe(
      Effect.tapError(() =>
        Effect.logError('Discord docs response delivery failed').pipe(
          Effect.annotateLogs({ outcome: 'response_delivery_failure', lastSuccessfulOrdinal }),
        ),
      ),
      Effect.withSpan('runtime.handlers.deliverDocsMessages'),
    )
  })
