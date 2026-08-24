import type { DiscordRestService } from 'dfx/DiscordREST'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { DiscordSnowflake, ThreadMutationError, type ThreadMutationPort } from '../threading/index.ts'

/**
 * Adapts the shared thread use case to DFX's generated, rate-limited REST
 * client. An unclassified transport failure is ambiguous: Discord may have
 * accepted the write before the response was lost, so the workflow must
 * reconcile instead of retrying it blindly.
 */
export const makeDfxThreadMutation = (rest: DiscordRestService): ThreadMutationPort => ({
  create: (input) =>
    rest
      .createThreadFromMessage(input.channelId, input.messageId, {
        name: input.name,
      })
      .pipe(
        Effect.flatMap((thread) => Schema.decodeUnknownEffect(DiscordSnowflake)(thread.id)),
        Effect.mapError(
          (cause) =>
            new ThreadMutationError({
              kind: isDefinitiveDiscordMutationFailure(cause) === true ? 'terminal' : 'ambiguous',
              code:
                isDefinitiveDiscordMutationFailure(cause) === true
                  ? 'discord_definitive_failure'
                  : 'discord_create_outcome_unknown',
              message:
                isDefinitiveDiscordMutationFailure(cause) === true
                  ? 'Discord definitively rejected thread creation'
                  : 'Discord thread creation did not return a safely classifiable result; reconcile before another write',
            }),
        ),
        Effect.withSpan('discord.threadMutation.create'),
      ),
})

/** A Discord 4xx response was rejected before this mutation could commit. */
export const isDefinitiveDiscordMutationFailure = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  if (!('name' in cause) || cause.name !== 'DiscordRestError') return false
  if (!('_tag' in cause) || cause._tag !== 'ErrorResponse') return false
  if (!('response' in cause) || typeof cause.response !== 'object' || cause.response === null) return false
  return (
    'status' in cause.response &&
    typeof cause.response.status === 'number' &&
    cause.response.status >= 400 &&
    cause.response.status < 500
  )
}
