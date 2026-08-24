import { Effect, Layer, Schema } from "effect"
import {
  DiscordActions,
  DiscordEventHandlers,
  type AutomaticMessage,
  type CreateThreadInteraction,
  type DocsInteraction,
} from "../discord/index.ts"
import { DocsWorkflow, renderDocsMessages } from "../docs/index.ts"
import {
  EnvironmentName,
  type ThreadCandidate,
  type ThreadOutcome,
} from "../threading/index.ts"
import type { RuntimeConfigPayload } from "./config.ts"

const createPublicThreads = 1n << 35n
const useApplicationCommands = 1n << 31n

export interface RuntimeWorkflows {
  readonly thread: (candidate: ThreadCandidate) => Effect.Effect<ThreadOutcome>
  /** Resolves a channel's parent through Discord REST; absent in fake mode. */
  readonly resolveDocsChannelParent?: (input: { readonly guildId: string; readonly channelId: string }) => Effect.Effect<{ readonly guildId: string; readonly parentChannelId?: string }, unknown>
  readonly docsReady?: boolean
}

export const makeDiscordEventHandlersLayer = (config: RuntimeConfigPayload, workflows: RuntimeWorkflows) =>
  Layer.effect(DiscordEventHandlers, Effect.gen(function* () {
    const actions = yield* DiscordActions
    const docs = yield* DocsWorkflow

    const onAutomaticMessage = Effect.fn("runtime.handlers.automaticMessage")(function* (input: AutomaticMessage) {
      yield* workflows.thread(toAutomaticCandidate(config, input))
      // Outcomes are content-free and intentionally not echoed into Discord.
    })

    const onCreateThreadInteraction = Effect.fn("runtime.handlers.createThreadInteraction")(function* (
      input: CreateThreadInteraction,
    ) {
      yield* actions.deferInteraction(input.route, "ephemeral")
      const authorized = hasPermission(input.actor.effectivePermissions, createPublicThreads) &&
        hasPermission(input.applicationPermissions, createPublicThreads)
      const outcome = yield* workflows.thread({
        ...toAutomaticCandidate(config, input.sourceMessage),
        trigger: {
          _tag: "DiscordManual",
          actorId: input.actor.userId,
          authorized,
          deliveryCorrelation: input.route.interactionId,
        },
      })
      yield* actions.editInteractionResponse({
        route: input.route,
        visibility: "ephemeral",
        content: renderThreadOutcome(outcome),
      })
    })

    const onDocsInteraction = Effect.fn("runtime.handlers.docsInteraction")(function* (input: DocsInteraction) {
      const resolved = workflows.resolveDocsChannelParent === undefined
        ? Effect.succeed({ guildId: input.guildId, parentChannelId: undefined })
        : workflows.resolveDocsChannelParent({ guildId: input.guildId, channelId: input.channelId }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const channel = yield* resolved
      const authorized = workflows.docsReady !== false && channel !== undefined && channel.guildId === config.guildId && docsAuthorized(config, input, channel.parentChannelId)
      if (!authorized) {
        yield* actions.respondInteraction({
          route: input.route,
          visibility: "ephemeral",
          content: "This channel or role is not configured for the documentation assistant.",
        })
        return
      }
      yield* actions.deferInteraction(input.route, "public")
      const result = yield* docs.query({
        surface: "discord",
        principalId: input.actor.userId,
        query: input.query,
      })
      const rendered = renderDocsMessages(result)
      if (rendered._tag === "RenderingFailed") {
        yield* actions.editInteractionResponse({
          route: input.route,
          visibility: "public",
          content: "The documentation answer could not be rendered safely for Discord.",
        })
        return
      }
      yield* deliverDocsMessages(actions, input.route, rendered.messages)
    })

    return DiscordEventHandlers.of({
      onAutomaticMessage: input => safelyHandle(onAutomaticMessage(input)),
      onCreateThreadInteraction: input => safelyHandle(onCreateThreadInteraction(input)),
      onDocsInteraction: input => safelyHandle(onDocsInteraction(input)),
    })
  }))

const toAutomaticCandidate = (config: RuntimeConfigPayload, input: AutomaticMessage): ThreadCandidate => ({
  environment: Schema.decodeUnknownSync(EnvironmentName)(config.environment),
  source: { guildId: input.guildId, channelId: input.channelId, messageId: input.messageId },
  sourceChannelKind: input.sourceChannelKind ?? "GuildText",
  messageKind: input.isReply ? "Reply" : input.authorIsSystem ? "System" : "Default",
  hasMessageReference: input.isReply,
  authorKind: input.authorIsBot
    ? "Bot"
    : input.hasWebhookAuthor
      ? "Webhook"
      : input.hasApplicationAuthor
        ? "Application"
        : "Human",
  existingThreadId: input.existingThreadId,
  content: input.content,
  attachmentCount: input.hasAttachments ? 1 : 0,
  hasPoll: input.hasPoll,
  stickerCount: 0,
  trigger: { _tag: "Automatic", deliveryCorrelation: input.messageId },
})

const hasPermission = (encoded: string, permission: bigint) => {
  try {
    return (BigInt(encoded) & permission) === permission
  } catch {
    return false
  }
}

const docsAuthorized = (config: RuntimeConfigPayload, input: DocsInteraction, parentChannelId?: string) => {
  if (!hasPermission(input.actor.effectivePermissions, useApplicationCommands)) return false
  if (!hasPermission(input.applicationPermissions, useApplicationCommands)) return false
  const channelId = parentChannelId ?? input.channelId
  if (config.docsAudience.publicChannelIds.includes(channelId)) return true
  return config.docsAudience.roleRestrictedChannelIds.includes(channelId) &&
    input.actor.roleIds.some(role => config.docsAudience.contributorMaintainerRoleIds.includes(role))
}

const renderThreadOutcome = (outcome: ThreadOutcome): string => {
  switch (outcome._tag) {
    case "Created": return `Created thread <#${outcome.threadId}>.`
    case "AlreadySatisfied": return `A thread already exists: <#${outcome.threadId}>.`
    case "AuthorizationRejected": return "You do not have permission to create this thread."
    case "PolicyRejected": return `This message is not eligible (${outcome.reason}).`
    case "TransientFailure": return `Thread creation is not safely complete (${outcome.failureCode}); an operator can reconcile it.`
    case "TerminalFailure": return `Thread creation failed (${outcome.failureCode}).`
  }
}

/** The Gateway callback cannot fail; report a content-free failure and keep serving. */
const safelyHandle = (effect: Effect.Effect<void, unknown>) => effect.pipe(
  Effect.catchCause(() => Effect.logError("Discord event handler failed")),
)

/** Delivers one public initial response followed by ordered public messages. */
export const deliverDocsMessages = (
  actions: typeof DiscordActions.Service,
  route: DocsInteraction["route"],
  messages: readonly [string, ...ReadonlyArray<string>],
) => Effect.suspend(() => {
  let lastSuccessfulOrdinal = 0
  return Effect.gen(function* () {
    const deliver = (content: string, followUp: boolean) => (followUp
      ? actions.followUpInteractionResponse({ route, visibility: "public", content })
      : actions.editInteractionResponse({ route, visibility: "public", content })).pipe(
        Effect.tap(() => Effect.sync(() => { lastSuccessfulOrdinal += 1 })),
      )

    yield* deliver(messages[0], false)
    for (const message of messages.slice(1)) yield* deliver(message, true)
  }).pipe(
    Effect.tapError(() => Effect.logError("Discord docs response delivery failed").pipe(
      Effect.annotateLogs({ outcome: "response_delivery_failure", lastSuccessfulOrdinal }),
    )),
    Effect.withSpan("runtime.handlers.deliverDocsMessages"),
  )
})
