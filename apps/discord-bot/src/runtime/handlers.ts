import { Cause, Effect, Layer, Option, Schema } from 'effect'

import {
  DiscordActions,
  DiscordEventHandlers,
  type AutomaticMessage,
  type CreateThreadInteraction,
  type DocsInteraction,
  type DiscordActionError,
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
/** Ephemeral denial texts (also used by the E2E broker to classify replies). */
export const docsNotConfiguredMessage = 'This channel or role is not configured for the documentation assistant.'
export const threadPermissionDeniedMessage = 'You do not have permission to create this thread.'

/** Discord thread channel types: announcement (10), public (11), and private (12) threads. */
const threadChannelTypes = new Set([10, 11, 12])

/**
 * Docs audience ancestry from a REST channel. Both independently supplied guild identities
 * must agree, and only a thread's parent is its audience channel: a text channel's
 * `parent_id` is its category and must never replace the channel itself.
 */
export const docsChannelAncestry = (
  channel: object,
  guildId: string,
): { readonly guildId: string; readonly parentChannelId?: string } => {
  const canonicalGuildId = 'guild_id' in channel && typeof channel.guild_id === 'string' ? channel.guild_id : ''
  const isThread = 'type' in channel && typeof channel.type === 'number' && threadChannelTypes.has(channel.type)
  return {
    guildId: canonicalGuildId === guildId ? canonicalGuildId : '',
    ...(isThread === true && 'parent_id' in channel && typeof channel.parent_id === 'string'
      ? { parentChannelId: channel.parent_id }
      : {}),
  }
}

export interface RuntimeWorkflows {
  readonly thread: (candidate: ThreadCandidate) => Effect.Effect<ThreadOutcome>
  /** Resolves a channel's parent through Discord REST; absent in fake mode. */
  readonly resolveDocsChannelParent?: (input: {
    readonly guildId: string
    readonly channelId: string
  }) => Effect.Effect<{ readonly guildId: string; readonly parentChannelId?: string }, DocsChannelResolutionError>
  /** An optional content-free sink for the worker's bounded automatic diagnostics. */
  readonly automaticDiagnostic?: (input: {
    readonly sourceMessageId: string
    readonly stage: 'received' | 'rejected' | 'created' | 'failed'
    readonly reason?: string
  }) => Effect.Effect<void>
  readonly correlateSourceId?: (sourceMessageId: string) => Effect.Effect<string>
  readonly docsReady?: boolean
  readonly docsHttpContinuation?: boolean
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
        yield* workflows.automaticDiagnostic?.({ sourceMessageId: input.messageId, stage: 'received' }) ?? Effect.void
        const outcome = yield* workflows.thread(toAutomaticCandidate(config, input))
        const reason =
          outcome._tag === 'PolicyRejected'
            ? outcome.reason
            : outcome._tag === 'TransientFailure' || outcome._tag === 'TerminalFailure'
              ? outcome.failureCode
              : 'none'
        const stage =
          outcome._tag === 'PolicyRejected'
            ? 'rejected'
            : outcome._tag === 'TransientFailure' || outcome._tag === 'TerminalFailure'
              ? 'failed'
              : 'created'
        yield* (
          workflows.automaticDiagnostic?.({
            sourceMessageId: input.messageId,
            stage,
            ...(reason === 'none' ? {} : { reason }),
          }) ?? Effect.void
        )
        const correlation =
          workflows.correlateSourceId === undefined ? undefined : yield* workflows.correlateSourceId(input.messageId)
        yield* (
          outcome._tag === 'TransientFailure' || outcome._tag === 'TerminalFailure'
            ? Effect.logWarning('[thread-automatic] outcome')
            : Effect.logInfo('[thread-automatic] outcome')
        ).pipe(
          Effect.annotateLogs({ ...(correlation === undefined ? {} : { correlation }), outcome: outcome._tag, reason }),
        )
        return outcome
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
            content: docsNotConfiguredMessage,
          })
          return
        }
        yield* actions.deferInteraction(input.route, 'public')
        const deliver = (responseActions: typeof DiscordActions.Service) =>
          Effect.gen(function* () {
            const result = yield* docs.query({
              surface: 'discord',
              principalId: input.actor.userId,
              query: input.query,
            })
            if (workflows.docsHttpContinuation === true) {
              yield* Effect.logInfo('Discord HTTP docs query completed').pipe(
                Effect.annotateLogs({ outcome: result._tag }),
              )
            }
            const rendered = renderDocsMessages(result)
            if (rendered._tag === 'RenderingFailed') {
              yield* responseActions.editInteractionResponse({
                route: input.route,
                visibility: 'public',
                content: 'The documentation answer could not be rendered safely for Discord.',
              })
              return
            }
            yield* deliverDocsMessages(responseActions, input.route, rendered.messages)
          })
        yield* workflows.docsHttpContinuation === true
          ? completeHttpDocsResponse(actions, input.route, deliver)
          : deliver(actions)
      })

      return DiscordEventHandlers.of({
        onAutomaticMessage: (input) => safelyHandle(onAutomaticMessage(input).pipe(Effect.orDie)),
        onCreateThreadInteraction: (input) => safelyHandle(onCreateThreadInteraction(input).pipe(Effect.orDie)),
        onDocsInteraction: (input) => safelyHandle(onDocsInteraction(input).pipe(Effect.orDie)),
      })
    }),
  )

const toAutomaticCandidate = (config: RuntimeConfigPayload, input: AutomaticMessage): ThreadCandidate => ({
  environment: Schema.decodeSync(EnvironmentName)(config.environment),
  source: { guildId: input.guildId, channelId: input.channelId, messageId: input.messageId },
  sourceChannelKind: input.sourceChannelKind ?? 'GuildText',
  messageKind:
    input.isReply === true ? 'Reply' : input.messageType === 0 && input.authorIsSystem === false ? 'Default' : 'System',
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
      return threadPermissionDeniedMessage
    case 'PolicyRejected':
      return `This message is not eligible (${outcome.reason}).`
    case 'TransientFailure':
      return `Thread creation is not safely complete (${outcome.failureCode}); an operator can reconcile it.`
    case 'TerminalFailure':
      return `Thread creation failed (${outcome.failureCode}).`
  }
}

/** The Gateway callback cannot fail; report a content-free failure and keep serving. */
const safelyHandle = <A>(effect: Effect.Effect<A, never>) =>
  effect.pipe(
    Effect.catchCause(() => Effect.logError('Discord event handler failed')),
    Effect.orDie,
  )

/** The HTTP callback has succeeded. Bound the in-memory work and clear Discord's pending reply on failure. */
export const completeHttpDocsResponse = (
  actions: typeof DiscordActions.Service,
  route: DocsInteraction['route'],
  deliver: (actions: typeof DiscordActions.Service) => Effect.Effect<void, DiscordActionError>,
) =>
  Effect.gen(function* () {
    let originalEditStarted = false
    let originalEdited = false
    const trackOriginalEdit: typeof DiscordActions.Service = {
      ...actions,
      editInteractionResponse: (message) =>
        Effect.suspend(() => {
          originalEditStarted = true
          return actions.editInteractionResponse(message).pipe(
            Effect.tap(() => {
              originalEdited = true
              return Effect.logInfo('Discord HTTP docs original response edited')
            }),
          )
        }),
    }
    yield* Effect.logInfo('Discord HTTP docs acknowledged')
    yield* deliver(trackOriginalEdit).pipe(
      Effect.timeout('65 seconds'),
      Effect.tap(() => Effect.logInfo('Discord HTTP docs response completed')),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause) === true) return yield* Effect.failCause(cause)
          const timedOut = Option.exists(Cause.findErrorOption(cause), Cause.isTimeoutError)
          yield* Effect.logWarning('Discord HTTP docs continuation failed').pipe(
            Effect.annotateLogs({ originalEditStarted, originalEdited, timedOut }),
          )
          // Discord may have applied an edit whose response was lost.
          if (originalEditStarted === true) return
          yield* actions
            .editInteractionResponse({
              route,
              visibility: 'public',
              content: 'The documentation assistant could not complete this request. Please try again.',
            })
            .pipe(
              Effect.timeout('5 seconds'),
              Effect.tap(() => Effect.logInfo('Discord HTTP docs fallback response sent')),
              Effect.catchCause(() => Effect.logWarning('Discord HTTP docs fallback response failed')),
            )
        }),
      ),
    )
  })

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
