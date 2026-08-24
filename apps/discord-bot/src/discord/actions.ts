import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { DiscordSnowflake } from '../threading/model.ts'
export { DiscordSnowflake }
export type { DiscordSnowflake as DiscordSnowflakeType } from '../threading/model.ts'

export const InteractionVisibility = Schema.Literals(['public', 'ephemeral'])
export type InteractionVisibility = typeof InteractionVisibility.Type

export const InteractionRoute = Schema.Struct({
  interactionId: DiscordSnowflake,
  applicationId: DiscordSnowflake,
  token: Schema.Redacted(Schema.NonEmptyString),
}).annotate({ identifier: 'Discord.InteractionRoute' })
export type InteractionRoute = typeof InteractionRoute.Type

export const InteractionMessage = Schema.Struct({
  route: InteractionRoute,
  content: Schema.String,
  visibility: InteractionVisibility,
}).annotate({ identifier: 'Discord.InteractionMessage' })
export type InteractionMessage = typeof InteractionMessage.Type

export class DiscordActionError extends Schema.TaggedError<DiscordActionError>()('DiscordActionError', {
  operation: Schema.Literals([
    'defer-interaction',
    'edit-interaction-response',
    'follow-up-interaction-response',
    'respond-interaction',
  ]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Narrow outbound Discord operations. Product workflows never depend on REST. */
export interface DiscordActionsService {
  readonly deferInteraction: (
    route: InteractionRoute,
    visibility: InteractionVisibility,
  ) => Effect.Effect<void, DiscordActionError>
  readonly editInteractionResponse: (message: InteractionMessage) => Effect.Effect<void, DiscordActionError>
  readonly followUpInteractionResponse: (message: InteractionMessage) => Effect.Effect<void, DiscordActionError>
  readonly respondInteraction: (message: InteractionMessage) => Effect.Effect<void, DiscordActionError>
}

export class DiscordActions extends Context.Service<DiscordActions, DiscordActionsService>()(
  'livestore-discord/DiscordActions',
) {}
