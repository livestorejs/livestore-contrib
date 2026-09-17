import { Schema } from '@livestore/utils/effect'

/**
 * Presence channel state schemas — defined once here and passed to both
 * `makeDurableObject({ presence: { schemas } })` and
 * `makePresenceClient({ channels })`. The Durable Object schema-decodes every
 * update before fan-out.
 */

/** Cursor + live-drag channel (Figma-style pointer tracking). */
export const CursorState = Schema.Struct({
  name: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
  dragging: Schema.optional(
    Schema.Struct({
      cardId: Schema.String,
      /** Offset from the card's top-left to the grab point within the card. */
      grabX: Schema.Finite,
      grabY: Schema.Finite,
    }),
  ),
})

export type CursorState = typeof CursorState.Type

/** The single source of truth for presence channels in this app. */
export const presenceSchemas = {
  cursor: CursorState,
} as const
