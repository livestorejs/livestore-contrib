import { randomUUID } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import { DiscordMessageRef, OperatorReason } from "../control/schema.ts"
import { ApplicationCommandScope } from "../application-commands/index.ts"
import { AutomaticMessage } from "../discord/events.ts"
import { acquireActionAuthority, ActionAuthorityUnavailable } from "./authority-lock.ts"
import { acquireRuntime } from "./app.ts"
import type { RuntimeConfigPayload } from "./config.ts"
import { makeUnixBotControlClient } from "./control.ts"

const guildId = "100000000000000001"
const channelId = "100000000000000002"
const messageId = "100000000000000003"

describe("deployable runtime tracer bullet", () => {
  it.effect("crosses Unix RPC, shared workflow, SQLite, fake Discord, docs, and readiness", () =>
    Effect.gen(function* () {
      const config = yield* testConfig
      const runtime = yield* acquireRuntime(config, "test-config.json")
      const client = yield* makeUnixBotControlClient(config.controlSocketPath)
      const source = yield* Schema.decodeUnknownEffect(DiscordMessageRef)({ guildId, channelId, messageId })
      const reason = yield* Schema.decodeUnknownEffect(OperatorReason)("runtime tracer bullet")

      const planned = yield* client.ThreadPlan({ source, name: "Runtime tracer", noAi: true })
      expect(planned._tag).toBe("Planned")

      const created = yield* client.ThreadCreate({ source, environment: "staging", apply: true, reason, name: "Runtime tracer" })
      expect(created._tag).toBe("Success")
      const duplicate = yield* client.ThreadCreate({ source, environment: "staging", apply: true, reason, name: "Runtime tracer" })
      expect(duplicate._tag).toBe("AlreadySatisfied")

      const status = yield* client.ThreadStatus({ source })
      expect(status.summary).toContain("state=created")
      const docs = yield* client.DocsQuery({ query: "What is an event?", refreshCorpus: false })
      expect(docs.summary).toContain("Fake source-backed answer")

      const reconciliation = yield* client.ThreadReconcile({
        source: yield* Schema.decodeUnknownEffect(DiscordMessageRef)({ guildId, channelId, messageId: "100000000000000099" }),
        all: false,
        apply: false,
      })
      expect(reconciliation._tag).toBe("Planned")
      expect(reconciliation.receiptId).toMatch(/^reconcile-/)

      const commandDiff = yield* client.ApplicationCommandsDiff({})
      expect(commandDiff.summary).toContain("changes=false")
      const commandSync = yield* client.ApplicationCommandsSync({ environment: "staging", apply: true, reason })
      expect(commandSync._tag).toBe("AlreadySatisfied")

      const automaticMessageId = "100000000000000004"
      yield* runtime.eventHandlers.onAutomaticMessage(yield* Schema.decodeUnknownEffect(AutomaticMessage)({
        guildId,
        channelId,
        messageId: automaticMessageId,
        authorId: "100000000000000005",
        authorIsBot: false,
        authorIsSystem: false,
        hasWebhookAuthor: false,
        hasApplicationAuthor: false,
        content: "How do I sync across tabs?",
        messageType: 0,
        isReply: false,
        hasAttachments: false,
        hasPoll: false,
      }))
      const automaticSource = yield* Schema.decodeUnknownEffect(DiscordMessageRef)({ guildId, channelId, messageId: automaticMessageId })
      expect((yield* client.ThreadStatus({ source: automaticSource })).summary).toContain("state=created")

      const ready = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${runtime.healthPort}/readyz`))
      expect(ready.status).toBe(200)
      expect(yield* Effect.tryPromise(() => ready.json())).toMatchObject({ apiVersion: 1, state: "ready", ready: true, restProbe: "ok", gateway: { state: "ready" } })
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("admits exactly one Action Authority owner", () =>
    Effect.gen(function* () {
      const config = yield* testConfig
      yield* acquireActionAuthority(config.stateDirectory)
      const rejected = yield* Effect.flip(Effect.scoped(acquireActionAuthority(config.stateDirectory)))
      expect(rejected).toBeInstanceOf(ActionAuthorityUnavailable)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})

const testConfig = Effect.gen(function* () {
  const stateDirectory = `/tmp/livestore-discord-runtime-${randomUUID()}`
  const fileSystem = yield* FileSystem.FileSystem
  yield* Effect.addFinalizer(() => fileSystem.remove(stateDirectory, { recursive: true, force: true }).pipe(Effect.orDie))
  return {
    _tag: "fake",
    environment: "staging",
    applicationId: "100000000000000010",
    commandScope: yield* Schema.decodeUnknownEffect(ApplicationCommandScope)({
      _tag: "GuildCommandScope",
      applicationId: "100000000000000010",
      guildId,
    }),
    guildId,
    schemaVersion: 1,
    actionChannelIds: [channelId],
    aiTitleChannelIds: [],
    docsAudience: { publicChannelIds: [channelId], roleRestrictedChannelIds: [], contributorMaintainerRoleIds: [] },
    stagingOnlyChannelIds: [],
    botTokenSecretRef: "op://vault/discord/token",
    openAi: { projectId: "proj", serviceAccountSecretRef: "op://vault/openai/key", retentionPosture: "standard-store-false", limits: { requestsPerMemberPerHour: 10, requestsPerMinute: 2, inputTokensPerRequest: 40000, outputTokensPerRequest: 2000, monthlyCostUsdMicros: 1000000 } },
    releaseId: "test-release",
    telemetry: { sink: "dev3-tempo", delivery: "best-effort", accessBoundary: "tailnet-trusted-grafana", retentionDays: 30 },
    e2e: { actorApplicationId: "100000000000000011", actorTokenSecretRef: "op://vault/discord/e2e", targetChannelId: channelId, requiredPurposeMarker: "livestore-discord-e2e-only" },
    legacyCommands: ["!help"],
    stateDirectory,
    controlSocketPath: `${stateDirectory}/control.sock`,
    health: { host: "127.0.0.1", port: 0 },
  } satisfies RuntimeConfigPayload
})
