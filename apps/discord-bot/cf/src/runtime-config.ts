import * as Effect from 'effect/Effect'
import type * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

// The node-free schema twin: src/runtime/config.ts itself pulls node:fs via
// loadRuntimeConfig and must never enter this worker graph.
import {
  canonicalizeRuntimeConfig,
  RuntimeConfigPayload,
  summarizeConfig,
} from '../../src/runtime/config-schema.ts'

import { keyValueStoreFromDurableStorage, type DurableStorage } from './storage.ts'

export { RuntimeConfigPayload }

/**
 * Single namespaced DO-storage key holding the serialized runtime config.
 * One key (not per-field entries) so reads are atomic and the stored shape is
 * exactly one decodable `RuntimeConfigPayload` document.
 */
export const runtimeConfigKey = 'livestore-discord/runtime-config'

/**
 * Boot fallback is deliberately not live-matrix-ready: it retains the legacy
 * single channel for non-AI staging traffic, disables AI titles, uses the
 * dedicated E2E actor, and carries a purpose marker that cannot match a live
 * channel. Operators must write the accepted two-channel cutover config before
 * matrix preflight. Host-realization fields that only exist on the Node host
 * (`credentials`, `stateDirectory`, `controlSocketPath`, `health`) carry
 * schema-valid placeholders because the edge host never touches them; secret
 * refs name Cloudflare Worker secrets resolved elsewhere.
 */
const channelId = '1373597443798859776'

/**
 * `RELEASE_ID` is injected by the deploy pipeline as a Worker binding;
 * guarded access keeps the default computable in plain Bun/node tests where
 * the binding is absent.
 */
const releaseIdFromEnv = (): string => {
  const value = typeof process === 'undefined' ? undefined : process.env['RELEASE_ID']
  return value === undefined || value.trim() === '' ? 'dev' : value
}

const rawDefaultRuntimeConfig = (releaseId: string) => ({
    _tag: 'real',
    schemaVersion: 1,
    environment: 'staging',
    applicationId: '1541431832195633232',
    guildId: '1154415661842452532',
    commandScope: { _tag: 'GuildCommandScope', applicationId: '1541431832195633232', guildId: '1154415661842452532' },
    actionChannelIds: [channelId],
    aiTitleChannelIds: [],
    stagingOnlyChannelIds: [channelId],
    legacyCommands: [],
    docsAudience: {
      publicChannelIds: [channelId],
      roleRestrictedChannelIds: ['1541442247864623114'],
      contributorMaintainerRoleIds: ['1373662624948162570', '1310653672786755584'],
    },
    botTokenSecretRef: 'cf-secret/DISCORD_BOT_TOKEN',
    openAi: {
      projectId: 'livestore-discord-staging',
      serviceAccountSecretRef: 'cf-secret/OPENAI_SERVICE_ACCOUNT',
      retentionPosture: 'standard-store-false',
      limits: {
        requestsPerMemberPerHour: 10,
        requestsPerMinute: 2,
        inputTokensPerRequest: 40000,
        outputTokensPerRequest: 2000,
        monthlyCostUsdMicros: 1000000,
      },
    },
    releaseId,
    diagnostics: {
      sink: 'cloudflare-provider',
      delivery: 'best-effort',
      accessPolicyId: 'cloudflare-access-policy/discord-bot-admin',
      retentionDays: 30,
    },
    e2e: {
      actorApplicationId: '1541440368212705380',
      actorTokenSecretRef: 'cf-secret/E2E_ACTOR_TOKEN',
      targetChannelId: channelId,
      requiredPurposeMarker: 'livestore-discord-e2e-cutover-required',
    },
    stateDirectory: '/var/lib/livestore-discord',
    controlSocketPath: '/var/lib/livestore-discord/control.sock',
    health: { host: '127.0.0.1', port: 8787 },
    credentials: {
      discordTokenFile: '/secrets/discord-token',
      openAiApiKeyFile: '/secrets/openai-api-key',
      docsCorrelationKeyFile: '/secrets/docs-correlation-key',
    },
  })

/**
 * The raw literal is decoded through the full `RuntimeConfigPayload` schema —
 * including its cross-field filter — so the default is validated at boot and
 * arrives with the branded snowflake types downstream handlers expect. A
 * regression in the literal fails fast here instead of poisoning handlers.
 */
export const makeDefaultRuntimeConfig = (releaseId: string = releaseIdFromEnv()): RuntimeConfigPayload =>
  Schema.decodeUnknownSync(RuntimeConfigPayload)(rawDefaultRuntimeConfig(releaseId))


const ConfigRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const RuntimeConfigDocument = Schema.Struct({
  revision: ConfigRevision,
  config: RuntimeConfigPayload,
}).annotate({ identifier: 'DiscordBot.RuntimeConfigDocument' })
export type RuntimeConfigDocument = typeof RuntimeConfigDocument.Type

/**
 * Config writes are deliberately explicit about whether the validated
 * document should merely be persisted or also become the running runtime.
 */
export const RuntimeConfigPutPayload = Schema.Struct({
  expectedRevision: ConfigRevision,
  config: RuntimeConfigPayload,
  reload: Schema.Boolean,
}).annotate({ identifier: 'DiscordBot.RuntimeConfigPutPayload' })
export type RuntimeConfigPutPayload = typeof RuntimeConfigPutPayload.Type

export class RuntimeConfigRevisionConflict extends Schema.TaggedError<RuntimeConfigRevisionConflict>()(
  'RuntimeConfigRevisionConflict',
  {
    expectedRevision: ConfigRevision,
    actualRevision: ConfigRevision,
  },
) {}

export interface RuntimeConfigStore {
  /**
   * Load-or-default. Revision zero represents the validated built-in default;
   * the first successful CAS write creates revision one. A corrupt persisted
   * document fails loudly because config controls policy boundaries.
   */
  readonly read: Effect.Effect<
    RuntimeConfigDocument,
    KeyValueStore.KeyValueStoreError | Schema.SchemaError
  >
  /**
   * Validates the candidate before touching storage, then compares the
   * caller's revision against the current durable document and persists the
   * next revision as one atomic value.
   */
  readonly write: (input: {
    readonly expectedRevision: number
    readonly config: unknown
  }) => Effect.Effect<
    RuntimeConfigDocument,
    KeyValueStore.KeyValueStoreError | Schema.SchemaError | RuntimeConfigRevisionConflict
  >
}

/**
 * Runtime-config delivery over one Durable Object key. The DO input gate
 * serializes the read/compare/write sequence, while the explicit revision
 * still protects operators from stale read-modify-write attempts.
 */

export const makeRuntimeConfigStore = (
  storage: DurableStorage,
  releaseId: string = releaseIdFromEnv(),
): RuntimeConfigStore => {
  const store = keyValueStoreFromDurableStorage(storage)
  const writeLock = Effect.runSync(Semaphore.make(1))
  // Legacy deployments stored a bare RuntimeConfigPayload at this same key.
  // Treat it as revision zero so the first guarded write upgrades the value
  // in place without making a valid live config unreadable during rollout.
  const StoredRuntimeConfig = Schema.Union([RuntimeConfigDocument, RuntimeConfigPayload])
  const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRuntimeConfig), {
    onExcessProperty: 'error',
  })
  const decodeConfig = Schema.decodeUnknownEffect(RuntimeConfigPayload, { onExcessProperty: 'error' })
  const encodeDocument = Schema.encodeSync(Schema.fromJsonString(RuntimeConfigDocument))

  const withCurrentRelease = (document: RuntimeConfigDocument): RuntimeConfigDocument => ({
    revision: document.revision,
    config: canonicalizeRuntimeConfig({ ...document.config, releaseId }),
  })

  const read: RuntimeConfigStore['read'] = Effect.flatMap(store.get(runtimeConfigKey), (raw) =>
    raw === undefined
      ? Effect.succeed({ revision: 0, config: makeDefaultRuntimeConfig(releaseId) })
      : Effect.map(decodeDocument(raw), (stored) =>
          withCurrentRelease('revision' in stored ? stored : { revision: 0, config: stored })),
  )

  const write: RuntimeConfigStore['write'] = ({ expectedRevision, config: input }) =>
    Semaphore.withPermits(writeLock, 1)(
      Effect.gen(function* () {
        // Validation is intentionally first: an invalid candidate never reaches
        // the storage read/CAS path and can never alter the repair document.
        const config = yield* decodeConfig(input)
        const current = yield* read
        if (current.revision !== expectedRevision) {
          return yield* new RuntimeConfigRevisionConflict({
            expectedRevision,
            actualRevision: current.revision,
          })
        }
        const next: RuntimeConfigDocument = {
          revision: current.revision + 1,
          config: canonicalizeRuntimeConfig({ ...config, releaseId }),
        }
        yield* store.set(runtimeConfigKey, encodeDocument(next))
        return next
      }),
    )

  return { read, write }
}

export interface RuntimeConfigSummary {
  readonly apiVersion: number
  readonly mode: 'fake' | 'real'
  readonly environment: 'staging' | 'production'
  readonly applicationId: string
  readonly commandScope: 'GuildCommandScope' | 'GlobalCommandScope'
  readonly guildId: string
  readonly actionChannelCount: number
  readonly parentChannelCount: number
  readonly aiTitleChannelCount: number
  readonly publicDocsChannelCount: number
  readonly restrictedDocsChannelCount: number
  readonly docsRoleCount: number
  readonly releaseId: string
  readonly diagnostics: {
    readonly sink: 'cloudflare-provider'
    readonly delivery: 'best-effort'
    readonly accessPolicyId: string
    readonly retentionDays: number
  }
  readonly stateDirectory: string
  readonly controlSocketPath: string
  readonly health: { readonly host: '127.0.0.1'; readonly port: number }
}

/**
 * JSON-safe config projection for the admin plane (`RuntimeStatus`,
 * policy-get). Reuses the Node host's `summarizeConfig` verbatim so both
 * hosts report identical shapes; the projection is counts and identifiers
 * only — no credentials, no raw channel lists beyond counts.
 */
export const encodeConfigSummary = (config: RuntimeConfigPayload): RuntimeConfigSummary => summarizeConfig(config)
