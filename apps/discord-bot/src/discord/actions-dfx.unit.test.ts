import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { InteractionRoute } from "./actions.ts"
import { followUpInteractionResponse } from "./actions-dfx.ts"

const route = Schema.decodeUnknownSync(InteractionRoute)({
  interactionId: "100000000000000001",
  applicationId: "100000000000000002",
  token: Redacted.make("interaction-token"),
})

describe("DFX Discord follow-up action", () => {
  it.effect("uses the application webhook and keeps public follow-ups public", () => Effect.gen(function* () {
    const calls: Array<unknown> = []
    yield* followUpInteractionResponse({
      executeWebhook: (webhookId, webhookToken, options) => Effect.sync(() => {
        calls.push({ webhookId, webhookToken, options })
        return {}
      }),
    }, { route, visibility: "public", content: "second" })

    expect(calls).toEqual([{
      webhookId: "100000000000000002",
      webhookToken: "interaction-token",
      options: {
        params: { wait: true },
        payload: { content: "second", flags: undefined, allowed_mentions: { parse: [] } },
      },
    }])
  }))
})
