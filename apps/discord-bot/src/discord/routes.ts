import { Discord } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  type AutomaticMessage,
  AutomaticMessage as AutomaticMessageSchema,
  type CreateThreadInteraction,
  CreateThreadInteraction as CreateThreadInteractionSchema,
  DiscordEventHandlers,
  type DiscordEventHandlersService,
  type DocsInteraction,
  DocsInteraction as DocsInteractionSchema,
} from "./events.ts"
import { decodeDiscordSourceMessage } from "./source-message.ts"
import { DiscordMessageRef } from "../threading/model.ts"

/** Installs credential-free-testable typed routes in the caller's scope. */
export const runDiscordRoutes = Effect.gen(function* () {
  const gateway = yield* DiscordGateway
  const handlers = yield* DiscordEventHandlers

  yield* gateway
    .handleDispatch("MESSAGE_CREATE", message => routeMessage(message, handlers))
    .pipe(Effect.forkScoped)

  yield* gateway
    .handleDispatch("INTERACTION_CREATE", interaction =>
      routeInteraction(interaction, handlers),
    )
    .pipe(Effect.forkScoped)
})

export const routeMessage = Effect.fn("discord.routeMessage")(function* (
  message: Discord.GatewayMessageCreateDispatchData,
  handlers: DiscordEventHandlersService,
) {
  const decoded = yield* decodeAutomaticMessage(message)
  if (Option.isSome(decoded)) yield* handlers.onAutomaticMessage(decoded.value)
})

export const routeInteraction = Effect.fn("discord.routeInteraction")(
  function* (
    interaction: Discord.GatewayInteractionCreateDispatchData,
    handlers: DiscordEventHandlersService,
  ) {
    if (interaction.type !== Discord.InteractionTypes.APPLICATION_COMMAND) return
    if (interaction.guild_id === undefined || interaction.channel_id === undefined) return
    if (interaction.member?.user === undefined) return

    if (
      interaction.data.type === Discord.ApplicationCommandType.MESSAGE &&
      interaction.data.name === "Create Thread"
    ) {
      const source = interaction.data.resolved.messages[interaction.data.target_id]
      if (source === undefined) return
      const decodedSource = yield* decodeAutomaticMessage({
        ...source,
        guild_id: interaction.guild_id,
      })
      if (Option.isNone(decodedSource)) return

      const input = yield* Schema.decodeUnknownEffect(CreateThreadInteractionSchema)({
        route: interactionRoute(interaction),
        guildId: interaction.guild_id,
        channelId: interaction.channel_id,
        actor: {
          userId: interaction.member.user.id,
          roleIds: interaction.member.roles,
          effectivePermissions: interaction.member.permissions,
        },
        sourceMessage: decodedSource.value,
        applicationPermissions: interaction.app_permissions,
      })
      yield* handlers.onCreateThreadInteraction(input)
      return
    }

    if (
      interaction.data.type === Discord.ApplicationCommandType.CHAT &&
      interaction.data.name === "docs"
    ) {
      const query = readStringOption(interaction.data.options, "query")
      if (query === undefined) return
      const input = yield* Schema.decodeUnknownEffect(DocsInteractionSchema)({
        route: interactionRoute(interaction),
        guildId: interaction.guild_id,
        channelId: interaction.channel_id,
        actor: {
          userId: interaction.member.user.id,
          roleIds: interaction.member.roles,
          effectivePermissions: interaction.member.permissions,
        },
        applicationPermissions: interaction.app_permissions,
        query,
      })
      yield* handlers.onDocsInteraction(input)
    }
  },
)

const decodeAutomaticMessage = (
  message: DiscordMessageLike,
): Effect.Effect<Option.Option<AutomaticMessage>, unknown> => {
  if (message.guild_id === undefined) return Effect.succeed(Option.none())
  return Effect.try({
    try: () => decodeDiscordSourceMessage(
      Schema.decodeUnknownSync(DiscordMessageRef)({
        guildId: message.guild_id,
        channelId: message.channel_id,
        messageId: message.id,
      }),
      message,
    ),
    catch: error => error,
  }).pipe(
    Effect.flatMap(facts => Schema.decodeUnknownEffect(AutomaticMessageSchema)({
      guildId: facts.source.guildId,
      channelId: facts.source.channelId,
      messageId: facts.source.messageId,
      authorId: facts.authorId,
      authorIsBot: facts.authorIsBot,
      authorIsSystem: facts.authorIsSystem,
      hasWebhookAuthor: facts.hasWebhookAuthor,
      hasApplicationAuthor: facts.hasApplicationAuthor,
      content: facts.content,
      messageType: facts.messageType,
      isReply: facts.isReply,
      hasAttachments: facts.attachmentCount > 0,
      hasPoll: facts.hasPoll,
      existingThreadId: facts.existingThreadId,
      sourceChannelKind: facts.sourceChannelKind,
    })),
    Effect.map(Option.some),
  )
}

/** Common subset shared by Gateway message events and resolved context messages. */
export interface DiscordMessageLike {
  readonly id: string
  readonly guild_id?: string
  readonly channel_id: string
  readonly author: {
    readonly id: string
    readonly bot?: boolean
    readonly system?: boolean
  }
  readonly content: string
  readonly type: number
  readonly webhook_id?: string
  readonly application_id?: string
  readonly message_reference?: { readonly message_id?: string }
  readonly attachments: ReadonlyArray<unknown>
  readonly poll?: unknown
  readonly thread?: { readonly id: string }
}

const interactionRoute = (
  interaction: Discord.APIApplicationCommandInteraction,
) => ({
  interactionId: interaction.id,
  applicationId: interaction.application_id,
  token: Redacted.make(interaction.token),
})

const readStringOption = (
  options: Discord.APIApplicationCommandInteractionDataOption[] | undefined,
  name: string,
) => {
  const option = options?.find(candidate => candidate.name === name)
  if (option === undefined) return undefined
  return option.type === Discord.ApplicationCommandOptionType.STRING
    ? option.value
    : undefined
}
