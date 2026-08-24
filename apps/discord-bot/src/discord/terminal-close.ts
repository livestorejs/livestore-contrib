import { DiscordWS } from "dfx/gateway"
import { LIB_VERSION } from "dfx/version"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const terminalGatewayCloseCodes = [
  4004, 4010, 4011, 4012, 4013, 4014,
] as const

export const GatewayCloseDisposition = Schema.Union(
  [
    Schema.TaggedStruct("Reconnect", { code: Schema.Int }),
    Schema.TaggedStruct("Terminate", { code: Schema.Int }),
  ],
).annotate({ identifier: "Discord.GatewayCloseDisposition" })
export type GatewayCloseDisposition = typeof GatewayCloseDisposition.Type

/** Mirrors the selected DFX capability used before its reconnect schedule. */
export const classifyGatewayClose = (code: number): GatewayCloseDisposition =>
  DiscordWS.isTerminalGatewayCloseCode(code)
    ? { _tag: "Terminate", code }
    : { _tag: "Reconnect", code }

export class TerminalCloseAdmissionError extends Schema.TaggedError<TerminalCloseAdmissionError>()(
  "TerminalCloseAdmissionError",
  {
    dfxVersion: Schema.NonEmptyString,
    message: Schema.String,
  },
) {}

/**
 * Opens runtime admission only for the pinned DFX identity with the patched
 * classifier and typed failure capability. The lockfile's patch hash remains
 * the immutable source identity; this probe prevents an unpatched 1.0.15 from
 * silently passing at runtime.
 */
export const assessDfxTerminalCloseAdmission: Effect.Effect<
  void,
  TerminalCloseAdmissionError
> = Effect.suspend(() => {
  const terminalSetIsExact = terminalGatewayCloseCodes.every(
    DiscordWS.isTerminalGatewayCloseCode,
  )
  const transientRemainsRetryable =
    DiscordWS.isTerminalGatewayCloseCode(4000) === false
  const typedFailureIsPresent =
    new DiscordWS.TerminalGatewayCloseError({ code: 4004 })._tag ===
    "TerminalGatewayCloseError"

  return LIB_VERSION === "1.0.15" &&
    terminalSetIsExact &&
    transientRemainsRetryable &&
    typedFailureIsPresent
    ? Effect.void
    : Effect.fail(
        new TerminalCloseAdmissionError({
          dfxVersion: LIB_VERSION,
          message:
            "Selected DFX does not expose the admitted exact terminal-close classifier and typed failure capability",
        }),
      )
})
