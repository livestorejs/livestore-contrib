import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { admitDocsProvider } from "./readiness.ts"

const expected = { projectId: "proj_staging", model: "gpt-5.6-luna" }

describe("docs provider readiness", () => {
  it("admits only an exact project/model/store posture", async () => {
    await expect(Effect.runPromise(admitDocsProvider({
      inspect: () => Effect.succeed({ ...expected, store: false as const, admitted: true }),
    }, expected))).resolves.toMatchObject({ admitted: true })
    await expect(Effect.runPromise(admitDocsProvider({
      inspect: () => Effect.succeed({ ...expected, projectId: "other", store: false as const, admitted: true }),
    }, expected))).rejects.toMatchObject({ reason: "wrong_project" })
  })
})
