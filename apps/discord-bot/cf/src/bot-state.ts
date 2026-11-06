import { SqliteClient } from '@effect/sql-sqlite-do'
import * as Cloudflare from 'alchemy/Cloudflare'
import { WorkerEnvironment } from 'alchemy/Cloudflare'
import { DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { DiscordConfig, layer as discordConfigLayer, type DiscordConfigService } from 'dfx/DiscordConfig'
import { DiscordWSCodec, DiscordWSLive, JsonDiscordWSCodecLive } from 'dfx/DiscordGateway/DiscordWS'
import { Messaging, MesssagingLive } from 'dfx/DiscordGateway/Messaging'
import { Shard, type RunningShard } from 'dfx/DiscordGateway/Shard'
import { ShardStateStore } from 'dfx/DiscordGateway/Shard/StateStore'
import { MemoryRateLimitStoreLive, RateLimitStore, type RateLimitStoreService } from 'dfx/RateLimit'
import type * as Discord from 'dfx/types'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import { FetchHttpClient } from 'effect/unstable/http'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'
import { layerWebSocketConstructorGlobal } from 'effect/unstable/socket/Socket'

import { makeDfxApplicationCommandsPort } from '../../src/application-commands/dfx.ts'
import { makeApplicationCommandsReconciler } from '../../src/application-commands/reconcile.ts'
import { type DiscordMessageRef } from '../../src/control/schema.ts'
import { DiscordActionsDfxLive } from '../../src/discord/actions-dfx.ts'
import { DiscordActions } from '../../src/discord/actions.ts'
import { DiscordEventHandlers, gatewayIntents } from '../../src/discord/events.ts'
import {
  describeDiscordRestFailure,
  discordSafeLoggerLayer,
  DiscordRestFailure,
  safeDiscordFailureMessage,
} from '../../src/discord/rest-error-redaction.ts'
import { routeInteraction, routeMessage } from '../../src/discord/routes.ts'
import { makeDfxThreadMutation } from '../../src/discord/thread-mutation-dfx.ts'
import { DocsWorkflow } from '../../src/docs/services.ts'
import type { DocsStateStore } from '../../src/docs/state-schema.ts'
import type { JournalUnavailableError, ThreadActionJournalService } from '../../src/journal/service.ts'
import { makeDfxThreadObservation } from '../../src/reconciliation/dfx.ts'
import type { ReconciliationSelection } from '../../src/reconciliation/model.ts'
import { makeThreadReconciliationWorkflowCore } from '../../src/reconciliation/workflow-core.ts'
import {
  docsChannelAncestry,
  DocsChannelResolutionError,
  makeDiscordEventHandlersLayer,
} from '../../src/runtime/handlers.ts'
import {
  candidateForOperator,
  makeDfxOperatorSourceReader,
  makeJournalReconciliation,
  OperatorSourceTransportError,
} from '../../src/runtime/threading-adapter.ts'
import { makeOpenAiThreadTitlePort } from '../../src/threading/openai-title.ts'
import { makeThreadWorkflow } from '../../src/threading/workflow.ts'
import {
  commandsSyncResultFromDiff,
  makeCommandsSyncOperation,
  makeOperatorThreadCreate,
  makeRuntimeConfigAdminOperations,
  OperatorThreadCreatePayload,
  portableReceiptDigestHex,
  reconcileOutcome,
  ThreadReconcilePayload,
  type AdminOperationOutcome,
} from './admin-ops.ts'
import {
  makeAutomaticDiagnostics,
  monitorDiscordCodec,
  sendDueGatewayHeartbeat,
  type AutomaticDiagnostics,
  type AutomaticDiagnosticsSnapshot,
} from './automatic-diagnostics.ts'
import { syncApplicationCommands } from './command-sync.ts'
import { makeCrypto } from './crypto.ts'
import { correlateWithWebCryptoKey, makeDocsServices } from './docs-services.ts'
import { makeKeyValueDocsStateStore } from './docs-state.ts'
import { readOptionalBinding, readSecret } from './env.ts'
import { makeGatewayLease } from './gateway-lease.ts'
import { makeSharedShardLayer } from './gateway-shard.ts'
import { makeDurableObjectGatewayTelemetrySink } from './gateway-telemetry-do.ts'
import {
  makeGatewayTelemetryRecorder,
  type GatewayTelemetryRecorder,
  type GatewayTelemetrySink,
  type GatewayTelemetrySnapshot,
} from './gateway-telemetry.ts'
import { makeSqliteDoThreadActionJournal, migrateJournal } from './journal.ts'
import {
  makeGatewayOwnerDeadline,
  makeSupervisorGate,
  makeGatewayAlarmRetry,
  scheduleGatewayAlarmIfMissing,
} from './loop-gate.ts'
import { awaitingAlarmBuildHealth, type GatewayHealthSummary } from './readiness.ts'
import { readReleaseId, readWorkerVersionId } from './release.ts'
import {
  encodeConfigSummary,
  makeDefaultRuntimeConfig,
  makeRuntimeConfigStore,
  type RuntimeConfigDocument,
  type RuntimeConfigStore,
  type RuntimeConfigSummary,
} from './runtime-config.ts'
import { makeInstanceFiberRunner, makeSerializedRuntime } from './runtime-install.ts'
// Selective imports ONLY: src/docs/index.ts re-exports node-bound modules
// (admission/workflow crypto, file state store) and must never enter this
// worker graph; src/runtime/config.ts (node:fs) is likewise avoided via its
// portable config-schema twin.
import { clearShardState, keyValueStoreFromDurableStorage, loadShardState, saveShardState } from './storage.ts'
import { defaultHandshakeTimeout, make as makeSupervisorLoop, makeShardAcquire } from './supervisor.ts'
import type { Supervisor, SupervisorState } from './supervisor.ts'

/** The alchemy DurableObjectState service instance yielded inside DO handlers. */
type DoInstanceState = InstanceType<typeof Cloudflare.DurableObjectState>

/** The bot runs a single-shard layout: one gateway connection per BotState object. */
const shardLayout = [0, 1] as const

/**
 * Liveness heartbeat cadence per supervisor state. Alarms exist to resurrect
 * supervision after isolate recycles, not to time retries — the supervision
 * loop owns backoff timing internally.
 */
const alarmDelayByState: Record<SupervisorState, number | undefined> = {
  stopped: undefined,
  ready: 30_000,
  connecting: 5_000,
  resuming: 5_000,
  disconnected: 5_000,
}

export interface BotStatus {
  readonly health: GatewayHealthSummary
  readonly journalSchemaVersion: number
  readonly docsMonthlySpentUsdMicros: number
  readonly configSummary: RuntimeConfigSummary
  readonly automaticDiagnostics: AutomaticDiagnosticsSnapshot
}
const makeGatewayHealthSummary = (input: {
  readonly supervisor: SupervisorState
  readonly sessionPresent: boolean
  readonly telemetry: GatewayTelemetrySnapshot | null
  readonly lastError: string | undefined
  readonly releaseId: string
  readonly workerVersionId: string | undefined
  readonly frames?: AutomaticDiagnosticsSnapshot['gatewayFrames']
}): GatewayHealthSummary => {
  const ack = input.frames?.lastHeartbeatAckAt
  const hello = input.frames?.lastHelloAt
  const observedAck =
    ack !== undefined && ack !== null && hello !== undefined && hello !== null && ack >= hello ? ack : null
  return {
    supervisor: input.supervisor,
    sessionPresent: input.sessionPresent,
    // DFX does not publish ACK lifecycle events. This instance's codec sees
    // them synchronously; project the observed ACK into the status snapshot.
    gateway:
      input.telemetry === null || observedAck === null
        ? input.telemetry
        : {
            lifetime: { ...input.telemetry.lifetime, lastHeartbeatAckAt: observedAck },
            current: { ...input.telemetry.current, lastHeartbeatAckAt: observedAck },
          },
    lastError: input.lastError ?? null,
    releaseId: input.releaseId,
    workerVersionId: input.workerVersionId ?? null,
  }
}

interface BotRuntime {
  readonly supervisor: Supervisor
  readonly telemetry: GatewayTelemetryRecorder
  readonly automaticDiagnostics: AutomaticDiagnostics
  readonly pulseGateway: Effect.Effect<void>
  readonly journal: ThreadActionJournalService
  readonly docsStore: DocsStateStore
  /** The validated runtime config driving policy boundaries and routing. */
  readonly configDocument: RuntimeConfigDocument
  readonly config: RuntimeConfigDocument['config']
  readonly configSummary: RuntimeConfigSummary
  /** Real operator trigger: journal claim → Discord API create → outcome. */
  readonly threadCreate: (payload: unknown) => Effect.Effect<AdminOperationOutcome>
  /** Real reconciliation over ambiguous journal entries (Node control-plane parity). */
  readonly threadReconcile: (payload: unknown) => Effect.Effect<AdminOperationOutcome>
  readonly runJournalMaintenance: (pendingPolicy: 'close-interrupted' | 'stale-only') => Effect.Effect<void>
  readonly commandsSync: (payload: unknown) => Effect.Effect<AdminOperationOutcome>
  /** Set when the journal could not be migrated; /readyz maps this to 503. */
  readonly migrationError: Option.Option<JournalUnavailableError>
}

const discordConfigService = (token: string): DiscordConfigService =>
  ({
    token: Redacted.make(token),
    rest: {
      baseUrl: 'https://discord.com/api/v10',
      globalRateLimit: { limit: 50, window: '1 seconds' },
    },
    gateway: { intents: gatewayIntents, identifyRateLimit: [5000, 1] },
  }) as DiscordConfigService

/** dfx's ShardStateStore over the SAME durable keys the supervisor checkpoints to. */
const shardStoreLayerFor = (rawStorage: DurableObjectStorage): Layer.Layer<ShardStateStore> =>
  Layer.succeed(
    ShardStateStore,
    ShardStateStore.of({
      forShard: ([id, count]) => ({
        get: Effect.map(loadShardState(rawStorage, [id, count]), (state) =>
          state === undefined || (state.sessionId === '' && state.sequence === null)
            ? Option.none()
            : Option.some(state),
        ),
        set: (state) => saveShardState(rawStorage, [id, count], state),
        clear: clearShardState(rawStorage, [id, count]),
      }),
    }),
  )

/**
 * Builds one dfx Shard connect inside the caller's per-attempt scope. The
 * Shard must consume the SAME Messaging hub returned to our dispatch pump:
 * ShardLive privately provides another MessagingLive and silently drops every
 * dispatch published to its own hub.
 */
/** One live shard session plus the raw gateway payload stream of its Messaging hub. */
type RunningShardWithDispatch = RunningShard & { readonly dispatches: Stream.Stream<unknown> }

const connectShard = (
  token: string,
  rawStorage: DurableObjectStorage,
  rateLimitStore: RateLimitStoreService,
  diagnostics: AutomaticDiagnostics,
  registerHeartbeat: (
    writer: ((sequence: number | null) => Effect.Effect<void>) | undefined,
    previous?: (sequence: number | null) => Effect.Effect<void>,
  ) => void,
): Effect.Effect<RunningShardWithDispatch, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    // The Messaging hub lives in THIS attempt scope: it dies with the session,
    // so no handler can publish into a stale socket's pipeline.
    const messaging = yield* Effect.map(Layer.build(MesssagingLive), (c) => Context.getUnsafe(c, Messaging))
    const codec = Context.get(yield* Layer.build(JsonDiscordWSCodecLive), DiscordWSCodec)
    const monitoredCodec = monitorDiscordCodec(codec, diagnostics)
    const context = yield* makeSharedShardLayer({
      messaging: Layer.succeed(Messaging, messaging),
      expectedHub: messaging.hub,
      discordWS: DiscordWSLive.pipe(Layer.provide(Layer.succeed(DiscordWSCodec, monitoredCodec))),
      rateLimitStore: Layer.succeed(RateLimitStore, rateLimitStore),
      config: Layer.succeed(DiscordConfig, discordConfigService(token)),
      shardStateStore: shardStoreLayerFor(rawStorage),
    }).pipe(Layer.build)
    const shard = Context.get(context, Shard)
    const running = yield* shard.connect([...shardLayout])
    const writer = (sequence: number | null) => running.write({ op: 1, d: sequence })
    yield* Effect.acquireRelease(
      Effect.sync(() => registerHeartbeat(writer)),
      () => Effect.sync(() => registerHeartbeat(undefined, writer)),
    )
    return {
      ...running,
      lifecycle: Stream.tap(running.lifecycle, (event) =>
        event._tag === 'Disconnected' ? Effect.sync(() => diagnostics.socketClosed(event.code)) : Effect.void,
      ),
      failure: running.failure.pipe(
        Effect.tapError((error) => Effect.sync(() => diagnostics.socketClosed(error.code))),
      ),
      dispatches: messaging.dispatch,
    }
  }).pipe(Effect.provide(layerWebSocketConstructorGlobal))

/**
 * Assembles the durable runtime once per BotState instance: SQLite journal
 * client (full storage handle — `withTransaction` breaks on bare `.sql`),
 * runtime-config store over key/value storage, docs quota store, the full
 * Discord event-handler stack (dfx REST actions, docs workflow, threading),
 * and the supervisor wired to the dfx shard through shared session keys.
 *
 * Event delivery is AT-LEAST-ONCE: gateway payloads are dispatched straight
 * from the live session into the handlers, and a resume can replay events.
 * Handlers are idempotent per gateway event — automatic/manual thread
 * creation claims its journal entry before any Discord mutation, so replays
 * collapse into AlreadySatisfied instead of duplicate threads.
 */
const buildRuntime = (
  doState: DoInstanceState,
  env: Record<string, unknown>,
  configDocument: RuntimeConfigDocument,
  configStore: RuntimeConfigStore,
  telemetrySink: GatewayTelemetrySink,
  onGatewayError: (error: string | undefined) => void,
  diagnostics: AutomaticDiagnostics,
  fallbackCorrelationKey: Uint8Array,
): Effect.Effect<BotRuntime> =>
  Effect.gen(function* () {
    const rawStorage = doState.raw.storage
    const token = readSecret(env, 'DISCORD_BOT_TOKEN')
    const crypto = makeCrypto()
    const telemetry = makeGatewayTelemetryRecorder(yield* crypto.randomUUID, telemetrySink)
    let gatewayHeartbeatWriter: ((sequence: number | null) => Effect.Effect<void>) | undefined
    const registerHeartbeat = (
      writer: ((sequence: number | null) => Effect.Effect<void>) | undefined,
      previous?: (sequence: number | null) => Effect.Effect<void>,
    ) => {
      if (previous === undefined || gatewayHeartbeatWriter === previous) gatewayHeartbeatWriter = writer
    }
    let persistedGatewayAckAt = 0
    const pulseGateway = Effect.gen(function* () {
      const frames = diagnostics.snapshot().gatewayFrames
      const ack = frames.lastHeartbeatAckAt
      if (ack !== null && frames.lastHelloAt !== null && ack >= frames.lastHelloAt && ack > persistedGatewayAckAt) {
        const aggregate = yield* telemetry.aggregate
        if (aggregate?.current.state === 'ready') {
          yield* telemetry.heartbeatAck(aggregate.current.attempt, ack)
          persistedGatewayAckAt = ack
        }
      }
      yield* sendDueGatewayHeartbeat(
        frames,
        Date.now(),
        gatewayHeartbeatWriter,
        Effect.map(loadShardState(rawStorage, shardLayout), (state) => state?.sequence ?? null),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`[bot-state] alarm heartbeat failed: ${safeDiscordFailureMessage(cause)}`),
      ),
    )

    // Built once per BotState instance (inert in-memory Map closure); shared
    // across every shard-connect attempt so identify throttling survives
    // reconnect storms.
    const rateLimitStore = yield* Effect.map(Effect.scoped(Layer.build(MemoryRateLimitStoreLive)), (context) =>
      Context.getUnsafe(context, RateLimitStore),
    )

    // The SQLite client's connection is an inert closure over the storage
    // handle (no destructive finalizers), so building it inside its own scope
    // keeps it usable across every later handler invocation.
    const client = yield* Effect.scoped(
      SqliteClient.make({ storage: rawStorage }).pipe(Effect.provide(Reactivity.layer)),
    )
    // Journal migration failure means the DO's durable journal is unusable
    // (e.g. a newer on-disk schema version). It must not kill the runtime:
    // supervision does not need the journal. The error is surfaced through
    // BotStatus.health.lastError so /readyz degrades to 503 with a cause.
    const migrationError: Option.Option<JournalUnavailableError> = yield* migrateJournal(client).pipe(
      Effect.map((): Option.Option<JournalUnavailableError> => Option.none()),
      Effect.catchIf(
        (_error): _error is JournalUnavailableError => true,
        (error) => Effect.succeed(Option.some(error)),
      ),
    )

    const keyValue = keyValueStoreFromDurableStorage(rawStorage)
    const journal = makeSqliteDoThreadActionJournal(client, crypto)
    const docsStore = makeKeyValueDocsStateStore(keyValue, crypto)

    // The caller supplies the exact revision being built. Reload candidates
    // therefore never need to be persisted before identity and dependency
    // validation succeeds.
    const config = configDocument.config
    const configSummary = encodeConfigSummary(config)

    // Shared workers-fetch dfx REST client for every outbound Discord call.
    const restContext = yield* Effect.scoped(
      Layer.build(
        DiscordRESTMemoryLive.pipe(
          Layer.provide(discordConfigLayer({ token: Redacted.make(token) })),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    )
    const rest = Context.get(restContext, DiscordREST)

    // Node parity (app.ts verifyDiscordApplicationIdentity): prove the token's
    // application identity BEFORE any handler or mutation path exists. A
    // mismatched token dies loudly instead of acting on the wrong guild.
    const identityStartedAt = Date.now()
    const identity = yield* rest.getMyOauth2Application().pipe(
      Effect.tapError((error) =>
        Effect.flatMap(describeDiscordRestFailure(error, Date.now() - identityStartedAt), (details) =>
          Effect.sync(() => {
            onGatewayError(`Discord identity check ${details}`)
            console.error('[bot-state] runtime identity failed', details)
          }),
        ),
      ),
      Effect.orDie,
    )
    if (identity.id !== config.applicationId) {
      return yield* Effect.die(
        new Error(
          `Discord application identity mismatch: token app ${identity.id} != configured ${config.applicationId}`,
        ),
      )
    }

    const actionsContext = yield* Effect.scoped(
      Layer.build(DiscordActionsDfxLive.pipe(Layer.provide(Layer.succeed(DiscordREST, rest)))),
    )
    const actions = Context.get(actionsContext, DiscordActions)

    const docsEnabled =
      config.docsAudience.publicChannelIds.length > 0 || config.docsAudience.roleRestrictedChannelIds.length > 0
    const openAiApiKey =
      docsEnabled === true || config.aiTitleChannelIds.length > 0 ? readSecret(env, 'OPENAI_API_KEY') : ''
    const configuredCorrelationKey = readSecret(env, 'DOCS_CORRELATION_KEY')
    const correlationKey = configuredCorrelationKey.trim() === '' ? fallbackCorrelationKey : configuredCorrelationKey
    const correlateSourceId = (sourceMessageId: string) =>
      correlateWithWebCryptoKey(correlationKey, sourceMessageId).pipe(
        Effect.map((digest) => digest.slice(0, 16)),
        Effect.orDie,
      )
    const recordAutomatic = (input: {
      readonly sourceMessageId: string
      readonly stage: 'received' | 'eligible' | 'rejected' | 'claimed' | 'rest-create-start' | 'created' | 'failed'
      readonly reason?: string
    }) =>
      correlateSourceId(input.sourceMessageId).pipe(
        Effect.flatMap((correlation) =>
          diagnostics.record({
            correlation,
            stage: input.stage,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        ),
      )
    const title = yield* makeOpenAiThreadTitlePort({ apiKey: Redacted.make(openAiApiKey) }).pipe(
      Effect.provide(FetchHttpClient.layer),
    )

    const threadWorkflow = makeThreadWorkflow(
      {
        reconciliation: makeJournalReconciliation(journal, correlateSourceId),
        mutation: makeDfxThreadMutation(rest),
        title,
      },
      {
        policy: {
          environment: config.environment,
          guildId: config.guildId,
          parentChannelIds: new Set(config.actionChannelIds),
          admittedParentKinds: new Set(['GuildText', 'GuildAnnouncement']),
          legacyCommands: new Set(config.legacyCommands),
        },
        title: { aiTitleChannelIds: new Set(config.aiTitleChannelIds) },
        onAutomaticMilestone: (sourceMessageId, stage) => recordAutomatic({ sourceMessageId, stage }),
      },
    )

    const docsContext = yield* Effect.scoped(
      Layer.build(
        makeDocsServices({
          openAiApiKey,
          correlationKey,
          // Disabled docs need no OpenAI deployment settings or provider key.
          ...(config.openAi === undefined ? {} : { openAiLimits: config.openAi.limits }),
          monthlyCostUsdMicros: config.openAi?.limits.monthlyCostUsdMicros,
          stateStore: docsStore,
        }),
      ),
    )
    const docs = Context.get(docsContext, DocsWorkflow)

    const resolveDocsChannelParent = ({ guildId, channelId }: { guildId: string; channelId: string }) =>
      rest.getChannel(channelId).pipe(
        Effect.map((channel) => docsChannelAncestry(channel, guildId)),
        Effect.mapError((cause) => new DocsChannelResolutionError({ message: 'Discord channel request failed' })),
      )

    const eventHandlers = yield* DiscordEventHandlers.pipe(
      Effect.provide(
        makeDiscordEventHandlersLayer(config, {
          thread: threadWorkflow,
          docsReady: true,
          resolveDocsChannelParent,
          automaticDiagnostic: recordAutomatic,
          correlateSourceId,
        }).pipe(Layer.provide(Layer.merge(Layer.succeed(DiscordActions, actions), Layer.succeed(DocsWorkflow, docs)))),
      ),
    )

    // Gateway payloads → typed routes → handlers. Unknown dispatch types are
    // ignored; MESSAGE_CREATE/INTERACTION_CREATE mirror the Node routes. The
    // pump must never fail (it shares the session fiber's scope), so decode
    // failures degrade to a content-free debug log — at-least-once redelivery
    // after a resume re-runs the idempotent handlers anyway.
    const onDispatch = (raw: unknown): Effect.Effect<void> => {
      const payload = raw as Discord.GatewayReceivePayload
      const routed =
        // DFX models gateway event names as a separate enum from dispatch payload types.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-enum-comparison
        payload.t === 'MESSAGE_CREATE'
          ? diagnostics.frameReceived.pipe(Effect.andThen(routeMessage(payload.d, eventHandlers)))
          : // oxlint-disable-next-line typescript-eslint/no-unsafe-enum-comparison
            payload.t === 'INTERACTION_CREATE'
            ? routeInteraction(payload.d, eventHandlers, docsEnabled)
            : Effect.void
      // The pump shares the session fiber's scope: a FAILURE or a DEFECT (e.g.
      // malformed gateway ids throwing inside decode) must degrade to a
      // content-free error log, never kill the pump while the socket is live.
      // At-least-once redelivery after a resume re-runs the idempotent
      // handlers for anything lost mid-failure.
      return routed.pipe(
        Effect.catchCause((cause) =>
          Effect.all([
            // oxlint-disable-next-line typescript-eslint/no-unsafe-enum-comparison
            payload.t === 'MESSAGE_CREATE'
              ? diagnostics.record({ stage: 'failed', reason: 'handler_error' })
              : Effect.void,
            Effect.logError(`[bot-state] dispatch handler ended: ${safeDiscordFailureMessage(cause)}`),
          ]).pipe(Effect.asVoid),
        ),
      )
    }

    const operatorThreadCreate = makeOperatorThreadCreate({
      config,
      sourceReader: makeDfxOperatorSourceReader({
        getMessage: (channelId, messageId) =>
          rest
            .getMessage(channelId, messageId)
            .pipe(
              Effect.mapError(
                () => new OperatorSourceTransportError({ message: 'Discord source message request failed' }),
              ),
            ),
      }),
      sourceObserver: makeDfxThreadObservation(rest),
      thread: threadWorkflow,
    })

    // Reconciles ambiguous entries by OBSERVING Discord only — the workflow
    // has no create port, so no recovery branch can replay a write.
    const reconcileWorkflow = makeThreadReconciliationWorkflowCore(journal, makeDfxThreadObservation(rest), {
      receiptDigestHex: portableReceiptDigestHex,
    })

    const runJournalMaintenance = (pendingPolicy: 'close-interrupted' | 'stale-only'): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* reconcileWorkflow({
          selection: { _tag: 'All', limit: 100 },
          mode: { _tag: 'Apply', reason: 'runtime bounded recovery' },
          now: Date.now(),
          pendingPolicy,
        })
        yield* journal.deleteExpiredTerminal({ now: Date.now() })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `[bot-state] journal maintenance (${pendingPolicy}) failed: ${safeDiscordFailureMessage(cause)}`,
          ),
        ),
        Effect.withSpan('discord.cf.journal.maintenance'),
      )

    const renderReconcile = (payload: Record<string, unknown>): Effect.Effect<AdminOperationOutcome> =>
      Effect.suspend(() => {
        if (payload.all !== (payload.source !== undefined)) {
          return Effect.succeed({
            ok: false,
            status: 422,
            body: { _tag: 'InvalidControlInput', message: 'Choose exactly one source or --all' },
          })
        }
        if (payload.apply === true && (payload.environment !== config.environment || payload.reason === undefined)) {
          return Effect.succeed({
            ok: false,
            status: 409,
            body: {
              _tag: 'ControlApplicationFailure',
              message: 'Apply requires the running environment and an operator reason',
            },
          })
        }
        const selection: ReconciliationSelection =
          payload.all === true
            ? {
                _tag: 'All',
                ...(payload.state === undefined ? {} : { state: payload.state as 'creating' | 'unknown_external' }),
                ...(payload.limit === undefined ? {} : { limit: payload.limit as number }),
              }
            : {
                _tag: 'One',
                // The payload schema already decoded + branded the snowflakes.
                sourceMessageId: (payload.source as typeof DiscordMessageRef.Type).messageId,
              }
        const applied = payload.apply === true
        return reconcileWorkflow({
          selection,
          mode:
            payload.apply === true && typeof payload.reason === 'string'
              ? ({ _tag: 'Apply', reason: payload.reason } as const)
              : ({ _tag: 'Plan' } as const),
          now: Date.now(),
        }).pipe(
          Effect.map((result) => reconcileOutcome(applied, result)),
          Effect.mapError(
            (): AdminOperationOutcome => ({
              ok: false,
              status: 500,
              body: { _tag: 'ControlApplicationFailure', message: 'Thread reconciliation failed' },
            }),
          ),
          Effect.catchIf(
            (error): error is AdminOperationOutcome => true,
            (error) => Effect.succeed<AdminOperationOutcome>(error),
          ),
        )
      })

    const threadReconcile = (raw: unknown): Effect.Effect<AdminOperationOutcome> =>
      Effect.flatMap(Schema.decodeUnknownEffect(ThreadReconcilePayload)(raw), (payload) =>
        renderReconcile(payload),
      ).pipe(
        Effect.catchIf(
          (error): error is Schema.SchemaError => true,
          () =>
            Effect.succeed<AdminOperationOutcome>({
              ok: false,
              status: 422,
              body: { _tag: 'InvalidControlInput', message: 'Request payload failed schema validation' },
            }),
        ),
      )

    const threadCreate = (payload: unknown): Effect.Effect<AdminOperationOutcome> =>
      Effect.flatMap(Schema.decodeUnknownEffect(OperatorThreadCreatePayload)(payload), (input) =>
        operatorThreadCreate(input),
      ).pipe(
        Effect.catchIf(
          (error): error is Schema.SchemaError => true,
          () =>
            Effect.succeed<AdminOperationOutcome>({
              ok: false,
              status: 422,
              body: { _tag: 'InvalidControlInput', message: 'Request payload failed schema validation' },
            }),
        ),
      )

    const commandReconciler = makeApplicationCommandsReconciler(makeDfxApplicationCommandsPort(rest), config)
    const commandsSync = makeCommandsSyncOperation({
      running: configDocument,
      readStored: configStore.read,
      plan: (scope) => commandReconciler.diff(scope).pipe(Effect.map(commandsSyncResultFromDiff)),
      apply: (scope) => syncApplicationCommands({ token, scope, config }),
    })

    return {
      supervisor: yield* makeSupervisorLoop(
        {
          acquire: makeShardAcquire({
            shard: shardLayout,
            connect: () => connectShard(token, rawStorage, rateLimitStore, diagnostics, registerHeartbeat),
            onDispatch,
            loadShardState: loadShardState(rawStorage, shardLayout),
            saveShardState: (state) => saveShardState(rawStorage, shardLayout, state),
            clearShardState: clearShardState(rawStorage, shardLayout),
          }),
          loadSession: Effect.map(loadShardState(rawStorage, shardLayout), (state) =>
            state !== undefined && state.sessionId !== '' && typeof state.sequence === 'number'
              ? {
                  sessionId: state.sessionId,
                  sequence: state.sequence,
                  ...(state.resumeUrl !== '' ? { resumeUrl: state.resumeUrl } : {}),
                }
              : null,
          ),
          saveSession: (session) =>
            saveShardState(rawStorage, shardLayout, {
              resumeUrl: session.resumeUrl ?? '',
              sessionId: session.sessionId,
              sequence: session.sequence,
            }),
          clearSession: clearShardState(rawStorage, shardLayout),
        },
        {
          initialBackoff: '1 seconds',
          maxBackoff: '60 seconds',
          telemetry,
          onHandshakeTimeout: (error) =>
            Effect.sync(() => {
              onGatewayError(error._tag)
            }),
          onEstablished: Effect.sync(() => {
            onGatewayError(undefined)
            console.info('[bot-state] gateway established READY/RESUMED')
          }),
        },
      ),
      automaticDiagnostics: diagnostics,
      pulseGateway,
      telemetry,
      journal,
      docsStore,
      configDocument,
      config,
      configSummary,
      threadCreate,
      threadReconcile,
      runJournalMaintenance,
      commandsSync,
      migrationError,
    }
  })

/**
 * BotState — the single durable object holding ALL durable bot state:
 * SQLite thread-action journal (DO SQL storage), dfx-compatible shard session
 * state and docs quota/provenance state (both over DO key/value storage), the
 * validated runtime config, and the gateway supervision loop whose live
 * session dispatches into the real event handlers (automatic threading,
 * /docs, Create Thread). One instance ("gateway") drives the live session;
 * alarms keep supervision alive across isolate recycles.
 *
 * No `sqlite` flag exists in Alchemy v2: every DO class new to a script is
 * deployed via a `new_sqlite_classes` migration automatically. DO members
 * must be functions — the RPC stub proxies calls, so Effect-valued properties
 * don't survive the stub boundary.
 */
export class BotState extends Cloudflare.DurableObject<BotState>()(
  'BotState',
  Effect.gen(function* () {
    // Init phase: resolve the per-instance state reference and the worker
    // environment (secrets) once; both are plain services here.
    const doState = yield* Cloudflare.DurableObjectState
    const env = yield* WorkerEnvironment

    // Runtime phase: storage methods are RuntimeContext-colored and may only
    // run inside these handlers.
    return Effect.gen(function* () {
      // Alchemy closes each RPC/alarm call scope after replying. Capture the
      // constructor's context so the gateway and its timers outlive that call.
      const instanceFibers = yield* makeInstanceFiberRunner
      const releaseId = readReleaseId(env)
      const stage = readOptionalBinding(env, 'DEPLOY_STAGE') === 'production' ? 'production' : 'staging'
      const applicationId = readOptionalBinding(env, 'DISCORD_APPLICATION_ID')
      const configStore = makeRuntimeConfigStore(
        doState.raw.storage,
        releaseId,
        stage,
        typeof applicationId === 'string' ? applicationId : undefined,
      )
      const telemetrySink = makeDurableObjectGatewayTelemetrySink(doState.raw.storage)
      const gate = yield* makeSupervisorGate
      // Serializes durable config mutation with command apply. The lifecycle
      // mutex alone blocks runtime swap but not the config CAS that precedes
      // activation; this outer gate keeps stored/running convergence stable
      // through Discord mutation and verification.
      const controlMutationLock = yield* Semaphore.make(1)
      const automaticDiagnostics = makeAutomaticDiagnostics()
      const fallbackCorrelationKey = yield* makeCrypto().randomBytes(32).pipe(Effect.orDie)
      let lastError: string | undefined
      let supervisorFiber: Fiber.Fiber<void, unknown> | undefined
      let awaitingAlarmBuild = true
      let awaitingAlarmBuildSinceMs = Date.now()
      const ownerDeadline = makeGatewayOwnerDeadline(35_000)
      // First boot and every alarm-owned reload close interrupted journal work.
      let startupMaintenanceDone = false
      const runtimeInstall = yield* makeSerializedRuntime(
        Effect.flatMap(Effect.orDie(configStore.read), (document) =>
          buildRuntime(
            doState,
            env,
            document,
            configStore,
            telemetrySink,
            (error) => {
              lastError = error
            },
            automaticDiagnostics,
            fallbackCorrelationKey,
          ),
        ),
        (candidate) => candidate.telemetry.activated,
      )

      const stopGateway = Effect.asVoid(
        runtimeInstall.reset(() =>
          Effect.gen(function* () {
            awaitingAlarmBuild = true
            awaitingAlarmBuildSinceMs = Date.now()
            if (supervisorFiber !== undefined) {
              yield* Fiber.interrupt(supervisorFiber)
              supervisorFiber = undefined
            }
            yield* gate.end
            ownerDeadline.reset()
            startupMaintenanceDone = false
          }),
        ),
      )
      const gatewayLease = yield* makeGatewayLease(stage, doState.raw.storage, stopGateway)
      const ensureAlarm = scheduleGatewayAlarmIfMissing(doState.raw.storage)
      const retryAlarm = makeGatewayAlarmRetry(doState.raw.storage)
      const ensureRuntime: Effect.Effect<BotRuntime> = gatewayLease.whileActive(
        () =>
          Effect.suspend(() =>
            awaitingAlarmBuild === true
              ? ensureAlarm.pipe(Effect.andThen(Effect.die(new Error('Gateway runtime awaiting alarm activation'))))
              : runtimeInstall.get,
          ),
        Effect.die(new Error('Staging gateway is parked')),
      )
      const withRuntime = <A>(f: (rt: BotRuntime) => Effect.Effect<A>): Effect.Effect<A> =>
        Effect.flatMap(ensureRuntime, f)
      const configAdmin = makeRuntimeConfigAdminOperations({
        store: configStore,
        getRunning: () => runtimeInstall.peek()?.configDocument,
        buildCandidate: (document) =>
          buildRuntime(
            doState,
            env,
            document,
            configStore,
            telemetrySink,
            (error) => {
              lastError = error
            },
            automaticDiagnostics,
            fallbackCorrelationKey,
          ),
        activateCandidate: () =>
          runtimeInstall
            .reset(() =>
              Effect.gen(function* () {
                // Validate in this RPC, but never install its context-bound
                // services. Only an alarm may build the running replacement.
                awaitingAlarmBuild = true
                awaitingAlarmBuildSinceMs = Date.now()
                if (supervisorFiber !== undefined) {
                  console.info('[bot-state] reload old-fiber interrupt begin')
                  yield* Fiber.interrupt(supervisorFiber)
                  supervisorFiber = undefined
                  console.info('[bot-state] reload old-fiber interrupt end')
                }
                yield* gate.end
                ownerDeadline.reset()
                console.info('[bot-state] reload gate released')
              }),
            )
            .pipe(
              Effect.andThen(
                gatewayLease.whileActive(
                  () =>
                    Effect.gen(function* () {
                      const deadline = Date.now()
                      yield* Effect.promise(() => doState.raw.storage.setAlarm(deadline))
                      console.info(`[bot-state] reload alarmDeadlineMs=${deadline}`)
                    }),
                  Effect.void,
                ),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  lastError = undefined
                }),
              ),
              Effect.asVoid,
            ),
      })

      const tick = (origin: 'alarm' | 'cron', expiresAt: number | undefined) =>
        Effect.gen(function* () {
          if (origin === 'cron') {
            // Cron can repair a missing alarm but cannot build or start the
            // owner. Cold boot and reload both enter through the same alarm.
            const alarm = yield* ensureAlarm
            console.info(
              `[bot-state] tick origin=cron alarmRepaired=${alarm.repaired} alarmDeadlineMs=${alarm.scheduledAt} nowMs=${Date.now()}`,
            )
            return { delay: 0 }
          }
          if (awaitingAlarmBuild === true) lastError = undefined
          yield* runtimeInstall.get.pipe(
            Effect.timeoutOption('20 seconds'),
            Effect.flatMap((result) =>
              Option.isSome(result) === true
                ? Effect.void
                : Effect.die(new DiscordRestFailure('GET', '/api/*', undefined, 'BuildTimeout')),
            ),
            Effect.onExit((exit) =>
              exit._tag === 'Failure'
                ? Effect.sync(() => {
                    lastError ??= safeDiscordFailureMessage(exit.cause)
                    console.error('[bot-state] runtime build failed', lastError)
                  })
                : Effect.void,
            ),
          )
          awaitingAlarmBuild = false
          const scheduledAlarm = yield* Effect.promise(() => doState.raw.storage.getAlarm())
          console.info(`[bot-state] tick origin=${origin} alarmScheduled=${scheduledAlarm !== null}`)

          // Re-read the installed runtime under the lifecycle mutex AFTER the
          // alarm await. Reload cannot swap between this selection, the gate
          // claim, and fiber publication; if it ran first, this tick starts B.
          const installed = yield* runtimeInstall.withCurrent((rt) =>
            Effect.gen(function* () {
              if (expiresAt !== undefined && Date.now() >= expiresAt) return null
              if (scheduledAlarm !== null) {
                yield* rt.telemetry.alarmObserved(Math.max(0, Date.now() - scheduledAlarm))
              }
              const gateClaimed = yield* gate.tryBegin
              const state = yield* rt.supervisor.state
              const now = Date.now()
              const { overdue } = ownerDeadline.observe(now, gateClaimed, state === 'ready' || state === 'stopped')
              console.info(`[bot-state] tick origin=${origin} gateClaimed=${gateClaimed} supervisor=${state}`)
              if (origin === 'alarm' && overdue === true) return { rt, startedFiber: undefined, stalled: true }
              if (gateClaimed === false) return { rt, startedFiber: undefined }
              if (state === 'stopped') {
                yield* gate.end
                return null
              }
              lastError = undefined
              const startedFiber = yield* instanceFibers.fork(
                rt.supervisor.run.pipe(
                  // The detached fiber is retained above so a config reload can
                  // interrupt and await the old gateway before swapping runtimes.
                  // Abnormal exits stay visible and always release the restart gate.
                  Effect.onExit((exit) =>
                    exit._tag === 'Failure'
                      ? Effect.sync(() => {
                          lastError = safeDiscordFailureMessage(exit.cause)
                          console.error('[bot-state] supervision loop ended', lastError)
                        })
                      : Effect.void,
                  ),
                  Effect.ensuring(gate.end),
                  // The instance context deliberately excludes per-call
                  // layers; retain the gateway's content-redacting logger.
                  Effect.provide(discordSafeLoggerLayer),
                ),
              )
              supervisorFiber = startedFiber
              yield* Effect.forkDetach(
                Effect.sleep('1 second').pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      const settled = startedFiber.pollUnsafe() !== undefined
                      console.info(
                        `[bot-state] supervisor origin=${origin} settledAfter1s=${settled} state=${yield* rt.supervisor.state}`,
                      )
                    }),
                  ),
                ),
              )
              return { rt, startedFiber }
            }),
          )
          if (installed === null) {
            if (expiresAt !== undefined) yield* Effect.promise(() => doState.raw.storage.setAlarm(expiresAt))
            return { delay: undefined }
          }
          const { rt, startedFiber } = installed
          if ('stalled' in installed) {
            const dropped = yield* runtimeInstall.reset(
              () =>
                Effect.gen(function* () {
                  awaitingAlarmBuild = true
                  awaitingAlarmBuildSinceMs = Date.now()
                  if (supervisorFiber !== undefined) {
                    yield* Fiber.interrupt(supervisorFiber)
                    supervisorFiber = undefined
                  }
                  yield* gate.end
                  ownerDeadline.reset()
                  startupMaintenanceDone = false
                }),
              installed.rt,
            )
            if (dropped === true) {
              console.warn('[bot-state] alarm restarting overdue gateway owner from stored config')
              yield* Effect.promise(() => doState.raw.storage.setAlarm(Date.now()))
            }
            return { delay: 0 }
          }

          if ((yield* rt.supervisor.state) === 'ready') yield* rt.pulseGateway
          if (startupMaintenanceDone === false) {
            startupMaintenanceDone = true
            yield* rt.runJournalMaintenance('close-interrupted')
          } else {
            yield* rt.runJournalMaintenance('stale-only')
          }

          const heartbeatInterval = automaticDiagnostics.snapshot().gatewayFrames.heartbeatIntervalMs
          const supervisorDelay = alarmDelayByState[yield* rt.supervisor.state]
          const delay =
            supervisorDelay === undefined || heartbeatInterval === null
              ? supervisorDelay
              : Math.min(supervisorDelay, Math.max(1_000, Math.floor(heartbeatInterval / 2)))
          if (delay === undefined && expiresAt === undefined) {
            yield* Effect.promise(() => doState.raw.storage.deleteAlarm())
            console.info(`[bot-state] tick origin=${origin} alarmDeleted=true`)
          } else {
            const deadline = Math.min(Date.now() + (delay ?? Infinity), expiresAt ?? Infinity)
            yield* Effect.promise(() => doState.raw.storage.setAlarm(new Date(deadline)))
            console.info(`[bot-state] tick origin=${origin} alarmDeadlineMs=${deadline}`)
          }
          // The alarm that starts a socket must remain in flight until the
          // first durable READY/RESUMED checkpoint (or the handshake deadline).
          // A detached socket built just before an alarm returns can otherwise
          // leave its OPEN event and timers stalled despite subsequent alarms.
          // Keep this wait outside the lifecycle mutex and after scheduling the
          // next alarm; reload interrupts the owner and releases the wait.
          const handshake =
            startedFiber === undefined
              ? Effect.void
              : Effect.raceFirst(rt.supervisor.awaitEstablished, Fiber.await(startedFiber)).pipe(
                  Effect.timeoutOption(defaultHandshakeTimeout),
                )
          return { delay, handshake }
        })

      const runTick = (origin: 'alarm' | 'cron') =>
        Effect.gen(function* () {
          const result = yield* gatewayLease.whileActive((expiresAt) => {
            const run = tick(origin, expiresAt)
            return origin === 'alarm' ? retryAlarm(run, expiresAt) : run
          }, Effect.undefined)
          // Keep the invocation alive during handshake while allowing an expiry
          // alarm or the owner to park and interrupt that handshake.
          if (result?.handshake !== undefined) yield* result.handshake
          return result?.delay
        })

      // A runtime that cannot build (corrupt stored config, dead journal) must
      // degrade /readyz to 503-with-cause instead of answering 500: report
      // schemaVersion 0 (readyz maps that to 503) plus the pretty cause.
      const degradedStatus = (health: GatewayHealthSummary): BotStatus => ({
        health,
        journalSchemaVersion: 0,
        docsMonthlySpentUsdMicros: 0,
        configSummary: encodeConfigSummary(
          makeDefaultRuntimeConfig(releaseId, stage, typeof applicationId === 'string' ? applicationId : undefined),
        ),
        automaticDiagnostics: automaticDiagnostics.snapshot(),
      })
      const status: Effect.Effect<BotStatus> = Effect.gen(function* () {
        const parked = yield* gatewayLease.whileActive(() => Effect.succeed(false), Effect.succeed(true))
        if (parked === true) {
          return degradedStatus(
            makeGatewayHealthSummary({
              supervisor: 'stopped',
              sessionPresent: false,
              telemetry: null,
              lastError: 'Staging gateway is parked',
              releaseId,
              workerVersionId: readWorkerVersionId(env),
            }),
          )
        }
        const rt = yield* ensureRuntime
        const session = yield* loadShardState(doState.raw.storage, shardLayout)
        // An unmigrated/unreadable journal reports schemaVersion 0, which the
        // /readyz probe maps to 503 — migration failure must degrade here,
        // not surface as an unhandled 500.
        const journalStatus =
          rt.migrationError._tag === 'Some'
            ? { schemaVersion: 0, error: rt.migrationError.value.message }
            : yield* rt.journal.inspectStorage.pipe(
                Effect.map((settings): { readonly schemaVersion: number; readonly error: string | undefined } => ({
                  schemaVersion: settings.schemaVersion,
                  error: undefined,
                })),
                Effect.catchIf(
                  (_error): _error is JournalUnavailableError => true,
                  (error) => Effect.succeed({ schemaVersion: 0, error: error.message }),
                ),
              )
        const supervisor = yield* rt.supervisor.state
        const sessionPresent = session !== undefined && session.sessionId !== ''
        const diagnostics = automaticDiagnostics.snapshot()
        return {
          health: makeGatewayHealthSummary({
            supervisor,
            sessionPresent,
            telemetry: yield* rt.telemetry.aggregate,
            lastError: journalStatus.error ?? lastError,
            releaseId,
            workerVersionId: readWorkerVersionId(env),
            frames: diagnostics.gatewayFrames,
          }),
          journalSchemaVersion: journalStatus.schemaVersion,
          docsMonthlySpentUsdMicros: yield* rt.docsStore.monthlySpent(Date.now()),
          configSummary: rt.configSummary,
          automaticDiagnostics: diagnostics,
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            degradedStatus(
              awaitingAlarmBuild === true
                ? awaitingAlarmBuildHealth({
                    sinceMs: awaitingAlarmBuildSinceMs,
                    lastBuildFailure: lastError,
                    releaseId,
                    workerVersionId: readWorkerVersionId(env),
                  })
                : makeGatewayHealthSummary({
                    supervisor: 'disconnected',
                    sessionPresent: false,
                    telemetry: null,
                    lastError: safeDiscordFailureMessage(cause),
                    releaseId,
                    workerVersionId: readWorkerVersionId(env),
                  }),
            ),
          ),
        ),
      )

      return {
        tick: () => runTick('cron').pipe(Effect.provide(discordSafeLoggerLayer)),

        gatewayActivate: (payload: unknown) =>
          gatewayLease.activate(payload).pipe(Effect.provide(discordSafeLoggerLayer)),

        gatewayPark: (payload: unknown) => gatewayLease.park(payload).pipe(Effect.provide(discordSafeLoggerLayer)),

        status: () => status.pipe(Effect.provide(discordSafeLoggerLayer)),

        threadCreate: (payload: unknown) =>
          withRuntime((rt) => rt.threadCreate(payload)).pipe(Effect.provide(discordSafeLoggerLayer)),

        threadReconcile: (payload: unknown) =>
          withRuntime((rt) => rt.threadReconcile(payload)).pipe(Effect.provide(discordSafeLoggerLayer)),

        configGet: () => configAdmin.configGet.pipe(Effect.provide(discordSafeLoggerLayer)),

        configPut: (payload: unknown) =>
          Semaphore.withPermits(
            controlMutationLock,
            1,
          )(configAdmin.configPut(payload)).pipe(Effect.provide(discordSafeLoggerLayer)),

        // Hold both control mutation and runtime lifecycle ownership through
        // the final stored/running recheck and REST mutation/verification.
        commandsSync: (payload: unknown) =>
          Semaphore.withPermits(
            controlMutationLock,
            1,
          )(Effect.flatMap(ensureRuntime, () => runtimeInstall.withCurrent((rt) => rt.commandsSync(payload)))).pipe(
            Effect.provide(discordSafeLoggerLayer),
          ),

        /** Cloudflare DO alarm entry point — the same heartbeat as `tick`. */
        alarm: () => runTick('alarm').pipe(Effect.provide(discordSafeLoggerLayer)),
      }
    })
  }),
) {}
