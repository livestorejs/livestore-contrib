import type * as Effect from 'effect/Effect'

import type { DiscordSnowflake } from '../journal/model.ts'
import type { ThreadObservation, ThreadObservationError } from './model.ts'

export interface ObserveSourceThreadInput {
  readonly sourceMessageId: DiscordSnowflake
  readonly channelId: DiscordSnowflake
}

/** Read-only by construction: reconciliation never receives a Discord create operation. */
export interface ThreadObservationPort {
  readonly observeSourceThread: (
    input: ObserveSourceThreadInput,
  ) => Effect.Effect<ThreadObservation, ThreadObservationError>
}
