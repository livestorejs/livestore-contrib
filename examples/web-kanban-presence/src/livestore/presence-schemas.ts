import { Schema } from '@livestore/utils/effect'

/**
 * Presence channel state schemas — defined once here and passed to BOTH the
 * party (`makeDurableObject({ presence: { schemas } })`) and the app's
 * `makePresenceClient({ channels })`, giving end-to-end typed updates that the
 * server validates before fan-out. More channels can be added later by adding
 * an entry here (e.g. a `chat` channel with typing indicators).
 */

/** Cursor + live-drag channel (Figma-style pointer tracking). */
export const CursorState = Schema.Struct({
  name: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
  dragging: Schema.optional(
    Schema.Struct({ cardId: Schema.String, deltaX: Schema.Finite, deltaY: Schema.Finite }),
  ),
})

export type CursorState = typeof CursorState.Type

/** The single source of truth for presence channels in this app. */
export const presenceSchemas = {
  cursor: CursorState,
} as const
