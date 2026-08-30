import type { DiscordRestService } from 'dfx/DiscordREST'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { DiscordSnowflake } from '../journal/model.ts'
import type { ThreadObservation } from './model.ts'
import type { ThreadObservationPort } from './port.ts'

type DfxThreadReader = Pick<DiscordRestService, 'getChannel'>

/**
 * Discord defines a thread started from a message to have the source message's
 * ID. GET channel therefore gives a source-anchored observation without a
 * search heuristic. We additionally require the recorded parent channel.
 * https://discord.com/developers/docs/resources/channel#start-thread-from-message
 */
export const makeDfxThreadObservation = (rest: DfxThreadReader): ThreadObservationPort => ({
  observeSourceThread: (input) =>
    rest.getChannel(input.sourceMessageId).pipe(
      Effect.match({
        onFailure: (cause): ThreadObservation =>
          discordStatus(cause) === 404 ? { _tag: 'Absent' } : { _tag: 'Unrun', reason: 'discord_read_unavailable' },
        onSuccess: (channel): ThreadObservation => classifyThreadChannel(input, channel),
      }),
      Effect.withSpan('discord.reconciliation.observeSourceThread'),
    ),
})

export const classifyThreadChannel = (
  input: { readonly sourceMessageId: string; readonly channelId: string },
  channel: unknown,
): ThreadObservation => {
  if (
    typeof channel === 'object' &&
    channel !== null &&
    'id' in channel &&
    channel.id === input.sourceMessageId &&
    'parent_id' in channel &&
    channel.parent_id === input.channelId &&
    'type' in channel &&
    (channel.type === 10 || channel.type === 11 || channel.type === 12)
  ) {
    return {
      _tag: 'ExactSourceThread',
      threadId: Schema.decodeUnknownSync(DiscordSnowflake)(channel.id),
    }
  }
  return { _tag: 'Unrun', reason: 'source_anchor_not_proven' }
}

const discordStatus = (cause: unknown): number | undefined => {
  if (typeof cause !== 'object' || cause === null || !('response' in cause)) return undefined
  const response = cause.response
  if (typeof response !== 'object' || response === null || !('status' in response)) return undefined
  return typeof response.status === 'number' ? response.status : undefined
}
