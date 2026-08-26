import * as Effect from 'effect/Effect'
import * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore'
import * as Schema from 'effect/Schema'

// The node-free schema twin: src/runtime/config.ts itself pulls node:fs via
// loadRuntimeConfig and must never enter this worker graph.
import { RuntimeConfigPayload, summarizeConfig } from '../../src/runtime/config-schema.ts'

import { keyValueStoreFromDurableStorage, type DurableStorage } from './storage.ts'

export { RuntimeConfigPayload }

/**
 * Single namespaced DO-storage key holding the serialized runtime config.
 * One key (not per-field entries) so reads are atomic and the stored shape is
 * exactly one decodable `RuntimeConfigPayload` document.
 */
export const runtimeConfigKey = 'livestore-discord/runtime-config'

/**
 * Boot fallback mirroring the accepted staging deployment: one shared channel
 * carries action/staging-only/AI-title/public-docs traffic, restricted docs
 * ride the two contributor/maintainer roles. Host-realization fields that only
 * exist on the Node host (`credentials`, `stateDirectory`, `controlSocketPath`,
 * `health`) carry schema-valid placeholders because the edge host never
 * touches them; secret refs name Cloudflare Worker secrets resolved elsewhere.
 * The E2E actor defaults to the bot's own application until an admin writes
 * the dedicated actor identity via `RuntimeConfigStore.write`.
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

const rawDefaultRuntimeConfig = () => ({
    _tag: 'real',
    schemaVersion: 1,
    environment: 'staging',
    applicationId: '1541431832195633232',
    guildId: '1154415661842452532',
    commandScope: { _tag: 'GuildCommandScope', applicationId: '1541431832195633232', guildId: '1154415661842452532' },
    actionChannelIds: [channelId],
    aiTitleChannelIds: [channelId],
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
    releaseId: releaseIdFromEnv(),
    telemetry: {
      sink: 'dev3-tempo',
      delivery: 'best-effort',
      accessBoundary: 'tailnet-trusted-grafana',
      retentionDays: 30,
    },
    e2e: {
      actorApplicationId: '1541431832195633232',
      actorTokenSecretRef: 'cf-secret/E2E_ACTOR_TOKEN',
      targetChannelId: channelId,
      requiredPurposeMarker: 'livestore-discord-e2e-only',
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
export const makeDefaultRuntimeConfig = (): RuntimeConfigPayload =>
  Schema.decodeUnknownSync(RuntimeConfigPayload)(rawDefaultRuntimeConfig())


export interface RuntimeConfigStore {
  /**
   * Load-or-default: the stored payload when present and decodable, otherwise
   * the staging-mirroring default. A present-but-corrupt document fails
   * loudly instead of silently degrading — config drives policy boundaries
   * (docs audience, channel routing), so silent fallback could change behavior
   * without anyone noticing.
   */
  readonly read: Effect.Effect<RuntimeConfigPayload, KeyValueStore.KeyValueStoreError | Schema.SchemaError>
  /** Validates via `RuntimeConfigPayload` (including its cross-field filter) before persisting. */
  readonly write: (
    payload: unknown,
  ) => Effect.Effect<void, KeyValueStore.KeyValueStoreError | Schema.SchemaError>
}

/**
 * Runtime-config delivery over Durable Object key/value storage. Values ride
 * the same string-only `KeyValueStore` lift the shard state and docs state
 * use; the DO's single-threaded execution model serializes writers.
 */
export const makeRuntimeConfigStore = (storage: DurableStorage): RuntimeConfigStore => {
  const store = keyValueStoreFromDurableStorage(storage)

  const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeConfigPayload), {
    onExcessProperty: 'error',
  })
  const decodePayload = Schema.decodeUnknownEffect(RuntimeConfigPayload, { onExcessProperty: 'error' })
  const encodeDocument = Schema.encodeSync(Schema.fromJsonString(RuntimeConfigPayload))

  const read: RuntimeConfigStore['read'] = Effect.flatMap(store.get(runtimeConfigKey), (raw) =>
    raw === undefined ? Effect.succeed(makeDefaultRuntimeConfig()) : decodeDocument(raw),
  )

  const write: RuntimeConfigStore['write'] = (payload) =>
    Effect.flatMap(decodePayload(payload), (config) => store.set(runtimeConfigKey, encodeDocument(config)))

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
