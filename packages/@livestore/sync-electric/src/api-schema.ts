import { LiveStoreEvent } from '@livestore/common/schema'
import { Schema } from '@livestore/utils/effect'

export const PushPayload = Schema.TaggedStruct('@livestore/sync-electric.Push', {
  storeId: Schema.String,
  batch: Schema.Array(LiveStoreEvent.Global.Encoded),
}).annotate({ title: '@livestore/sync-electric.PushPayload' })

export const PullPayload = Schema.TaggedStruct('@livestore/sync-electric.Pull', {
  storeId: Schema.String,
  // `optional` so an absent payload is omitted from the JSON entirely (a required key with an
  // `undefined` value would be dropped by `JSON.stringify` and then fail decoding as "Missing key").
  payload: Schema.optional(Schema.Json),
  // `toCodecJson` makes the `Option` encode to its JSON-safe struct form (`{ _tag: "None" }` /
  // `{ _tag: "Some", value }`). A bare `Schema.Option` encodes to a runtime `Option`, whose
  // `toJSON` leaks `{"_id":"Option",...}` when `fromJsonString` runs `JSON.stringify`, and that
  // shape then fails to decode back into an `Option`.
  handle: Schema.toCodecJson(
    Schema.Option(
      Schema.Struct({
        offset: Schema.String,
        handle: Schema.String,
      }),
    ),
  ),
  live: Schema.Boolean,
}).annotate({ title: '@livestore/sync-electric.PullPayload' })

export const ApiPayload = Schema.Union([PullPayload, PushPayload])

// Format for the query params
export const ArgsSchema = Schema.StringFromUriComponent.pipe(Schema.decodeTo(Schema.fromJsonString(PullPayload)))
