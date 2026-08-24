import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Effect, Stream } from "effect"
import { assessDfxTerminalCloseAdmission } from "../discord/terminal-close.ts"
import { awaitGatewayReadySignal, GatewayReadinessError, verifyDiscordApplicationIdentity } from "./app.ts"
import { RuntimeConfigFile, summarizeConfig } from "./config.ts"
import { isDefinitiveDiscordMutationFailure } from "./threading-adapter.ts"

const base = {
  environment: "staging",
  applicationId: "100000000000000010",
  commandScope: {
    _tag: "GuildCommandScope",
    applicationId: "100000000000000010",
    guildId: "100000000000000001",
  },
  guildId: "100000000000000001",
  schemaVersion: 1,
  actionChannelIds: ["100000000000000002"],
  aiTitleChannelIds: [],
  docsAudience: { publicChannelIds: ["100000000000000002"], roleRestrictedChannelIds: [], contributorMaintainerRoleIds: [] },
  stagingOnlyChannelIds: [],
  botTokenSecretRef: "op://vault/discord/token",
  openAi: { projectId: "proj", serviceAccountSecretRef: "op://vault/openai/key", retentionPosture: "standard-store-false", limits: { requestsPerMemberPerHour: 10, requestsPerMinute: 2, inputTokensPerRequest: 40000, outputTokensPerRequest: 2000, monthlyCostUsdMicros: 1000000 } },
  releaseId: "test-release",
  telemetry: { sink: "dev3-tempo", delivery: "best-effort", accessBoundary: "tailnet-trusted-grafana", retentionDays: 30 },
  e2e: { actorApplicationId: "100000000000000011", actorTokenSecretRef: "op://vault/discord/e2e", targetChannelId: "100000000000000002", requiredPurposeMarker: "livestore-discord-e2e-only" },
  legacyCommands: ["!help"],
  stateDirectory: "/tmp/livestore-discord",
  controlSocketPath: "/tmp/livestore-discord/control.sock",
  health: { host: "127.0.0.1", port: 0 },
}

describe("runtime config", () => {
  it("strictly decodes a versioned fake config", () => {
    const decoded = Schema.decodeUnknownSync(RuntimeConfigFile)({ apiVersion: 1, payload: { _tag: "fake", ...base } })
    expect(summarizeConfig(decoded.payload)).toMatchObject({ apiVersion: 1, mode: "fake", environment: "staging" })
  })

  it("rejects embedded credential values and unknown versions", () => {
    expect(() => Schema.decodeUnknownSync(RuntimeConfigFile, { onExcessProperty: "error" })({
      apiVersion: 1,
      payload: { _tag: "real", ...base, credentials: { discordTokenFile: "/run/x", openAiApiKeyFile: "/run/y", discordToken: "secret" } },
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeConfigFile)({ apiVersion: 2, payload: { _tag: "fake", ...base } })).toThrow()
  })

  it("rejects the retired identity, mismatched scope, and global staging commands", () => {
    expect(() => Schema.decodeUnknownSync(RuntimeConfigFile)({
      apiVersion: 1,
      payload: { _tag: "fake", ...base, applicationId: "1310646763505582171", commandScope: { _tag: "GlobalCommandScope", applicationId: "1310646763505582171" } },
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeConfigFile)({
      apiVersion: 1,
      payload: { _tag: "fake", ...base, commandScope: { _tag: "GlobalCommandScope", applicationId: base.applicationId } },
    })).toThrow()
  })

  it("rejects private or unmanaged AI-title channels and ambiguous docs audiences", () => {
    for (const payload of [
      { ...base, aiTitleChannelIds: ["100000000000000003"] },
      {
        ...base,
        actionChannelIds: [...base.actionChannelIds, "100000000000000003"],
        aiTitleChannelIds: ["100000000000000003"],
      },
      { ...base, aiTitleChannelIds: ["100000000000000003"] },
      { ...base, docsAudience: { ...base.docsAudience, roleRestrictedChannelIds: base.docsAudience.publicChannelIds, contributorMaintainerRoleIds: ["100000000000000004"] } },
      { ...base, docsAudience: { ...base.docsAudience, roleRestrictedChannelIds: ["100000000000000003"] } },
    ]) {
      expect(() => Schema.decodeUnknownSync(RuntimeConfigFile)({
        apiVersion: 1,
        payload: { _tag: "fake", ...payload },
      })).toThrow()
    }
  })

  it("accepts AI titles only in public managed channels and role-backed restricted docs channels", () => {
    expect(() => Schema.decodeUnknownSync(RuntimeConfigFile)({
      apiVersion: 1,
      payload: {
        _tag: "fake",
        ...base,
        aiTitleChannelIds: base.actionChannelIds,
        aiTitleDisclosureVersion: "openai-store-false-v1",
        docsAudience: { publicChannelIds: base.docsAudience.publicChannelIds, roleRestrictedChannelIds: ["100000000000000003"], contributorMaintainerRoleIds: ["100000000000000004"] },
      },
    })).not.toThrow()
  })

  it("admits the terminal-close-safe DFX capability", async () => {
    await expect(Effect.runPromise(assessDfxTerminalCloseAdmission)).resolves.toBeUndefined()
  })

  it("classifies only decoded Discord 4xx responses as definitive mutations", () => {
    expect(isDefinitiveDiscordMutationFailure({ name: "DiscordRestError", _tag: "ErrorResponse", response: { status: 403 } })).toBe(true)
    expect(isDefinitiveDiscordMutationFailure({ name: "DiscordRestError", _tag: "ErrorResponse", response: { status: 500 } })).toBe(false)
    expect(isDefinitiveDiscordMutationFailure({ _tag: "HttpClientError", reason: { _tag: "TransportError" } })).toBe(false)
  })

  it("fails closed when the token application identity differs", async () => {
    await expect(Effect.runPromise(verifyDiscordApplicationIdentity({
      getMyOauth2Application: () => Effect.succeed({ id: base.applicationId }),
    }, base.applicationId))).resolves.toBeUndefined()
    await expect(Effect.runPromise(verifyDiscordApplicationIdentity({
      getMyOauth2Application: () => Effect.succeed({ id: "100000000000000099" }),
    }, base.applicationId))).rejects.toMatchObject({ _tag: "DiscordIdentityAdmissionError" })
  })

  it("admits readiness only after an actual READY dispatch", async () => {
    await expect(Effect.runPromise(awaitGatewayReadySignal(Stream.make({ _tag: "Ready", shardId: 0 }), Effect.never)))
      .resolves.toBeUndefined()
    for (const malformed of [null, {}, { _tag: "Ready", shardId: Number.NaN }]) {
      await expect(Effect.runPromise(awaitGatewayReadySignal(Stream.make(malformed), Effect.never)))
        .rejects.toMatchObject({ _tag: "GatewayReadinessError", reason: "stream_ended" })
    }
    await expect(Effect.runPromise(awaitGatewayReadySignal(Stream.empty, Effect.never)))
      .rejects.toMatchObject({ _tag: "GatewayReadinessError", reason: "stream_ended" })
    await expect(Effect.runPromise(awaitGatewayReadySignal(Stream.never, Effect.fail(new GatewayReadinessError({ reason: "terminal_failure", message: "terminal_gateway_failure" })))))
      .rejects.toMatchObject({ _tag: "GatewayReadinessError", reason: "terminal_failure" })
  })
})
