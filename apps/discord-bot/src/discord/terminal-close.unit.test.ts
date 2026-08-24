import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import {
  assessDfxTerminalCloseAdmission,
  classifyGatewayClose,
  terminalGatewayCloseCodes,
} from "./terminal-close.ts"

describe("Gateway terminal-close admission", () => {
  it.each(terminalGatewayCloseCodes)("terminates for fatal code %i", code => {
    expect(classifyGatewayClose(code)).toEqual({ _tag: "Terminate", code })
  })

  it.each([1000, 4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009])(
    "leaves transient or resumable code %i with DFX",
    code => {
      expect(classifyGatewayClose(code)).toEqual({ _tag: "Reconnect", code })
    },
  )

  it("admits the pinned DFX identity only with the patched capability", async () => {
    await expect(
      Effect.runPromise(assessDfxTerminalCloseAdmission),
    ).resolves.toBeUndefined()
  })
})
