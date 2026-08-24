import { Discord, DiscordREST } from 'dfx'
import type { DiscordRestService } from 'dfx/DiscordREST'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'

import { DiscordActionError, DiscordActions, type InteractionMessage, type InteractionRoute } from './actions.ts'

/** DFX is the only production implementation of the Discord action port. */
export const DiscordActionsDfxLive = Layer.effect(
  DiscordActions,
  Effect.gen(function* () {
    const rest = yield* DiscordREST

    return DiscordActions.of({
      deferInteraction: (route, visibility) =>
        rest
          .createInteractionResponse(route.interactionId, Redacted.value(route.token), {
            payload: {
              type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
              data: visibility === 'ephemeral' ? { flags: Discord.MessageFlags.Ephemeral } : undefined,
            },
          })
          .pipe(
            Effect.asVoid,
            mapActionError('defer-interaction', 'Discord failed to defer the interaction'),
            Effect.withSpan('discord.actions.deferInteraction'),
          ),
      editInteractionResponse: (message) =>
        rest
          .updateOriginalWebhookMessage(message.route.applicationId, Redacted.value(message.route.token), {
            payload: { content: message.content, allowed_mentions: { parse: [] } },
          })
          .pipe(
            Effect.asVoid,
            mapActionError('edit-interaction-response', 'Discord failed to edit the deferred interaction response'),
            Effect.withSpan('discord.actions.editInteractionResponse'),
          ),
      followUpInteractionResponse: (message) =>
        followUpInteractionResponse(
          {
            executeWebhook: (webhookId, webhookToken, options) =>
              rest.executeWebhook(webhookId, webhookToken, options).pipe(
                Effect.mapError(
                  (cause) =>
                    new DiscordActionError({
                      operation: 'follow-up-interaction-response',
                      message: 'Discord failed to send an interaction follow-up response',
                      cause,
                    }),
                ),
              ),
          },
          message,
        ),
      respondInteraction: (message) => respondInteraction(rest, message),
    })
  }),
)

interface FollowUpRest {
  readonly executeWebhook: (
    webhookId: string,
    webhookToken: string,
    options: {
      readonly params: { readonly wait: true }
      readonly payload: {
        readonly content: string
        readonly flags?: number
        readonly allowed_mentions: { readonly parse: readonly [] }
      }
    },
  ) => Effect.Effect<unknown, DiscordActionError>
}

/** Application follow-ups use the interaction token as a webhook credential. */
export const followUpInteractionResponse = (rest: FollowUpRest, message: InteractionMessage) =>
  rest
    .executeWebhook(message.route.applicationId, Redacted.value(message.route.token), {
      params: { wait: true },
      payload: {
        content: message.content,
        allowed_mentions: { parse: [] },
        ...(message.visibility === 'ephemeral' ? { flags: Discord.MessageFlags.Ephemeral } : {}),
      },
    })
    .pipe(
      Effect.asVoid,
      mapActionError('follow-up-interaction-response', 'Discord failed to send an interaction follow-up response'),
      Effect.withSpan('discord.actions.followUpInteractionResponse'),
    )

const respondInteraction = (rest: DiscordRestService, message: InteractionMessage) =>
  rest
    .createInteractionResponse(message.route.interactionId, Redacted.value(message.route.token), {
      payload: {
        type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: message.content,
          allowed_mentions: { parse: [] },
          flags: message.visibility === 'ephemeral' ? Discord.MessageFlags.Ephemeral : undefined,
        },
      },
    })
    .pipe(
      Effect.asVoid,
      mapActionError('respond-interaction', 'Discord failed to send the interaction response'),
      Effect.withSpan('discord.actions.respondInteraction'),
    )

const mapActionError = (operation: DiscordActionError['operation'], message: string) =>
  Effect.mapError((cause: unknown) => new DiscordActionError({ operation, message, cause }))
