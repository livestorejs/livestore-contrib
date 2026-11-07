import { Discord } from 'dfx'
import type { DiscordWS } from 'dfx/DiscordGateway/DiscordWS'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { DiscordMessageRef } from '../threading/model.ts'
import type { RelayOutbox } from './outbox.ts'

/**
 * DFX checkpoints the sequence after take returns. A storage failure must
 * terminate this consumer rather than advancing beyond an unqueued event.
 */
export const captureRelayMessages = (input: {
  readonly socket: typeof DiscordWS.Service
  readonly guildId: string
  readonly channels: ReadonlySet<string>
  readonly outbox: Pick<RelayOutbox, 'enqueue'>
  readonly onCaptureFailure: Effect.Effect<void>
}): typeof DiscordWS.Service => ({
  connect: (options) =>
    Effect.map(input.socket.connect(options), (connection) => ({
      ...connection,
      take: Effect.tap(connection.take, (frame) =>
        Effect.sync(() => {
          if (frame.op !== Discord.GatewayOpcodes.Dispatch || frame.t !== Discord.GatewayDispatchEvents.MessageCreate)
            return
          const message = frame.d
          if (message.guild_id !== input.guildId || input.channels.has(message.channel_id) === false) return
          input.outbox.enqueue(
            Schema.decodeSync(DiscordMessageRef)({
              guildId: message.guild_id,
              channelId: message.channel_id,
              messageId: message.id,
            }),
          )
        }).pipe(Effect.onError(() => input.onCaptureFailure)),
      ),
    })),
})
