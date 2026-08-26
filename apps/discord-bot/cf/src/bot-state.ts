import { SqliteClient } from '@effect/sql-sqlite-do'

import * as Cloudflare from 'alchemy/Cloudflare'
import { WorkerEnvironment } from 'alchemy/Cloudflare'

import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import type * as Scope from 'effect/Scope'
import * as Schema from 'effect/Schema'
import type * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore'
import * as Stream from 'effect/Stream'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'
import { FetchHttpClient } from 'effect/unstable/http'
import { layerWebSocketConstructorGlobal, WebSocketConstructor } from 'effect/unstable/socket/Socket'

import { DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { DiscordConfig, layer as discordConfigLayer, type DiscordConfigService } from 'dfx/DiscordConfig'
import type * as Discord from 'dfx/types'
import { JsonDiscordWSCodecLive } from 'dfx/DiscordGateway/DiscordWS'
import { Messaging, MesssagingLive } from 'dfx/DiscordGateway/Messaging'
import { Shard, ShardLive, type RunningShard } from 'dfx/DiscordGateway/Shard'
import { ShardStateStore } from 'dfx/DiscordGateway/Shard/StateStore'
import { MemoryRateLimitStoreLive, RateLimitStore, type RateLimitStoreService } from 'dfx/RateLimit'

// Selective imports ONLY: src/docs/index.ts re-exports node-bound modules
// (admission/workflow crypto, file state store) and must never enter this
// worker graph; src/runtime/config.ts (node:fs) is likewise avoided via its
// portable config-schema twin.
import {
  clearShardState,
  keyValueStoreFromDurableStorage,
  loadShardState,
  saveShardState,
} from './storage.ts'
import { readSecret } from './env.ts'
import { makeCrypto } from './crypto.ts'
import { makeSupervisorGate } from './loop-gate.ts'
import { makeKeyValueDocsStateStore } from './docs-state.ts'
import { makeSqliteDoThreadActionJournal, migrateJournal } from './journal.ts'
import { make as makeSupervisorLoop, makeShardAcquire } from './supervisor.ts'
import type { Supervisor, SupervisorState } from './supervisor.ts'
import {
  commandsSyncOutcome,
  makeOperatorThreadCreate,
  OperatorThreadCreatePayload,
  portableReceiptDigestHex,
  reconcileOutcome,
  ThreadReconcilePayload,
  type AdminOperationOutcome,
} from './admin-ops.ts'
import {
  encodeConfigSummary,
  makeDefaultRuntimeConfig,
  makeRuntimeConfigStore,
  RuntimeConfigPayload,
  type RuntimeConfigSummary,
} from './runtime-config.ts'
import { makeDocsServices } from './docs-services.ts'
import { syncApplicationCommands, type SyncApplicationCommandsError } from './command-sync.ts'
import { DiscordActions } from '../../src/discord/actions.ts'
import { DiscordActionsDfxLive } from '../../src/discord/actions-dfx.ts'
import { DiscordEventHandlers, gatewayIntents } from '../../src/discord/events.ts'
import { routeInteraction, routeMessage } from '../../src/discord/routes.ts'
import { DocsWorkflow } from '../../src/docs/services.ts'
import { type DiscordMessageRef } from '../../src/control/schema.ts'
import type { DocsStateStore } from '../../src/docs/state-schema.ts'
import { makeThreadWorkflow } from '../../src/threading/workflow.ts'
import { makeOpenAiThreadTitlePort } from '../../src/threading/openai-title.ts'
import { makeDfxThreadMutation } from '../../src/discord/thread-mutation-dfx.ts'
import { makeDfxThreadObservation } from '../../src/reconciliation/dfx.ts'
import { makeThreadReconciliationWorkflowCore } from '../../src/reconciliation/workflow-core.ts'
import type { ReconciliationSelection } from '../../src/reconciliation/model.ts'
import {
  candidateForOperator,
  makeDfxOperatorSourceReader,
  makeJournalReconciliation,
  OperatorSourceTransportError,
} from '../../src/runtime/threading-adapter.ts'
import { DocsChannelResolutionError, makeDiscordEventHandlersLayer } from '../../src/runtime/handlers.ts'
import { JournalUnavailableError, type ThreadActionJournalService } from '../../src/journal/service.ts'

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
  readonly supervisor: SupervisorState
  readonly hasSession: boolean
  readonly journalSchemaVersion: number
  readonly docsMonthlySpentUsdMicros: number
  readonly configSummary: RuntimeConfigSummary
  /** Last fatal supervision-loop error message, when one was recorded. */
  readonly lastError: string | undefined
}

interface BotRuntime {
  readonly supervisor: Supervisor
  readonly journal: ThreadActionJournalService
  readonly docsStore: DocsStateStore
  /** The validated runtime config driving policy boundaries and routing. */
  readonly config: RuntimeConfigPayload
  readonly configSummary: RuntimeConfigSummary
  /** Real operator trigger: journal claim → Discord API create → outcome. */
  readonly threadCreate: (payload: unknown) => Effect.Effect<AdminOperationOutcome>
  /** Real reconciliation over ambiguous journal entries (Node control-plane parity). */
  readonly threadReconcile: (payload: unknown) => Effect.Effect<AdminOperationOutcome>
  /**
   * Bounded recovery pass. 'close-interrupted' at startup closes pre-existing
   * pending claims; 'stale-only' runs periodically off the cron/alarm tick —
   * the exact pending policies of the Node runtime's runJournalMaintenance.
   */
  readonly runJournalMaintenance: (pendingPolicy: 'close-interrupted' | 'stale-only') => Effect.Effect<void>
  readonly configGet: Effect.Effect<AdminOperationOutcome>
  readonly configPut: (payload: unknown) => Effect.Effect<AdminOperationOutcome>
  readonly commandsSync: Effect.Effect<AdminOperationOutcome>
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
            : Option.some(state)),
        set: (state) => saveShardState(rawStorage, [id, count], state),
        clear: clearShardState(rawStorage, [id, count]),
      }),
    }),
  )

/**
 * Builds one dfx Shard connect inside the CALLER's scope — which the
 * supervisor supplies per attempt: cheap queue/pubsub services rebuild each
 * attempt, so socket fibers finalize the moment an attempt ends. The dfx
 * Messaging service is captured from the same layer graph: its dispatch hub
 * is exactly what the acquire seam pumps into the event handlers, and its
 * PubSub shutdown finalizer fires with the attempt scope (no zombie hub).
 */
/** One live shard session plus the raw gateway payload stream of its Messaging hub. */
type RunningShardWithDispatch = RunningShard & { readonly dispatches: Stream.Stream<unknown> }

const connectShard = (
  token: string,
  rawStorage: DurableObjectStorage,
  rateLimitStore: RateLimitStoreService,
): Effect.Effect<RunningShardWithDispatch, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    // The Messaging hub lives in THIS attempt scope: it dies with the session,
    // so no handler can publish into a stale socket's pipeline.
    const messaging = yield* Effect.map(Layer.build(MesssagingLive), (c) => Context.getUnsafe(c, Messaging))
    const context = yield* ShardLive.pipe(
      Layer.provide(JsonDiscordWSCodecLive),
      Layer.provide(Layer.succeed(Messaging, messaging)),
      Layer.provide(Layer.effect(RateLimitStore, Effect.succeed(rateLimitStore))),
      Layer.provide(Layer.succeed(DiscordConfig, discordConfigService(token))),
      Layer.provide(shardStoreLayerFor(rawStorage)),
      Layer.build,
    )
    const shard = Context.get(context, Shard)
    const running = yield* shard.connect([...shardLayout])
    return { ...running, dispatches: messaging.dispatch }
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
const buildRuntime = (doState: DoInstanceState, env: Record<string, unknown>): Effect.Effect<BotRuntime> =>
  Effect.gen(function* () {
    const rawStorage = doState.raw.storage
    const token = readSecret(env, 'DISCORD_BOT_TOKEN')

    // Built once per BotState instance (inert in-memory Map closure); shared
    // across every shard-connect attempt so identify throttling survives
    // reconnect storms.
    const rateLimitStore = yield* Effect.map(
      Effect.scoped(Layer.build(MemoryRateLimitStoreLive)),
      (context) => Context.getUnsafe(context, RateLimitStore),
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
    // BotStatus.lastError so /readyz degrades to 503 with a cause.
    const migrationError: Option.Option<JournalUnavailableError> = yield* migrateJournal(client).pipe(
      Effect.map((): Option.Option<JournalUnavailableError> => Option.none()),
      Effect.catchIf(
        (_error): _error is JournalUnavailableError => true,
        (error) => Effect.succeed(Option.some(error)),
      ),
    )

    const crypto = makeCrypto()
    const keyValue = keyValueStoreFromDurableStorage(rawStorage)
    const journal = makeSqliteDoThreadActionJournal(client, crypto)
    const docsStore = makeKeyValueDocsStateStore(keyValue, crypto)

    // Load-or-default runtime config; a corrupt stored document fails LOUDLY
    // here (by design, as an unhandled defect) instead of silently degrading
    // policy boundaries.
    const configStore = makeRuntimeConfigStore(rawStorage)
    const config = yield* Effect.orDie(configStore.read)
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
    const identity = yield* rest.getMyOauth2Application().pipe(Effect.orDie)
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

    const openAiApiKey = readSecret(env, 'OPENAI_API_KEY')
    const correlationKey = readSecret(env, 'DOCS_CORRELATION_KEY')
    const title = yield* makeOpenAiThreadTitlePort({ apiKey: Redacted.make(openAiApiKey) }).pipe(
      Effect.provide(FetchHttpClient.layer),
    )

    const threadWorkflow = makeThreadWorkflow(
      {
        reconciliation: makeJournalReconciliation(journal),
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
      },
    )

    const docsContext = yield* Effect.scoped(
      Layer.build(makeDocsServices({
        openAiApiKey,
        ...(correlationKey.trim() === '' ? {} : { correlationKey }),
        // Only the real deployment variant carries OpenAI ceilings; the fake
        // variant runs the docs workflow on its defaults.
        ...(config._tag === 'real' ? { openAiLimits: config.openAi.limits } : {}),
        monthlyCostUsdMicros: config._tag === 'real' ? config.openAi.limits.monthlyCostUsdMicros : undefined,
        stateStore: docsStore,
      })),
    )
    const docs = Context.get(docsContext, DocsWorkflow)

    const resolveDocsChannelParent = ({ guildId, channelId }: { guildId: string; channelId: string }) =>
      rest.getChannel(channelId).pipe(
        Effect.map((channel) => {
          const canonicalGuildId =
            'guild_id' in channel && typeof channel.guild_id === 'string' ? channel.guild_id : ''
          return {
            // Both independently supplied identities must agree; an absent or
            // inconsistent REST ancestry therefore fails audience admission.
            guildId: canonicalGuildId === guildId ? canonicalGuildId : '',
            ...('parent_id' in channel && typeof channel.parent_id === 'string'
              ? { parentChannelId: channel.parent_id }
              : {}),
          }
        }),
        Effect.mapError((cause) => new DocsChannelResolutionError({ message: 'Discord channel request failed' })),
      )

    const eventHandlers = yield* DiscordEventHandlers.pipe(
      Effect.provide(
        makeDiscordEventHandlersLayer(config, {
          thread: threadWorkflow,
          docsReady: true,
          resolveDocsChannelParent,
        }).pipe(
          Layer.provide(
            Layer.merge(Layer.succeed(DiscordActions, actions), Layer.succeed(DocsWorkflow, docs)),
          ),
        ),
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
        payload.t === 'MESSAGE_CREATE'
          ? routeMessage(payload.d, eventHandlers)
          : payload.t === 'INTERACTION_CREATE'
            ? routeInteraction(payload.d, eventHandlers)
            : Effect.void
      // The pump shares the session fiber's scope: a FAILURE or a DEFECT (e.g.
      // malformed gateway ids throwing inside decode) must degrade to a
      // content-free error log, never kill the pump while the socket is live.
      // At-least-once redelivery after a resume re-runs the idempotent
      // handlers for anything lost mid-failure.
      return routed.pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`[bot-state] dispatch handler ended: ${Cause.pretty(cause)}`),
        ),
      )
    }

    const operatorThreadCreate = makeOperatorThreadCreate({
      config,
      sourceReader: makeDfxOperatorSourceReader({
        getMessage: (channelId, messageId) =>
          rest.getMessage(channelId, messageId).pipe(
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
          Effect.logError(`[bot-state] journal maintenance (${pendingPolicy}) failed: ${Cause.pretty(cause)}`),
        ),
        Effect.withSpan('discord.cf.journal.maintenance'),
      )

    const renderReconcile = (payload: Record<string, unknown>): Effect.Effect<AdminOperationOutcome> =>
      Effect.suspend(() => {
        if (payload.all !== (payload.source !== undefined)) {
          return Effect.succeed({ ok: false, status: 422, body: { _tag: 'InvalidControlInput', message: 'Choose exactly one source or --all' } })
        }
        if (
          payload.apply === true &&
          (payload.environment !== config.environment || payload.reason === undefined)
        ) {
          return Effect.succeed({
            ok: false,
            status: 409,
            body: { _tag: 'ControlApplicationFailure', message: 'Apply requires the running environment and an operator reason' },
          })
        }
        const selection: ReconciliationSelection =
          payload.all === true
            ? {
                _tag: 'All',
                ...(payload.state === undefined
                  ? {}
                  : { state: payload.state as 'creating' | 'unknown_external' }),
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
          Effect.mapError((): AdminOperationOutcome => ({
            ok: false,
            status: 500,
            body: { _tag: 'ControlApplicationFailure', message: 'Thread reconciliation failed' },
          })),
          Effect.catchIf(
            (error): error is AdminOperationOutcome => true,
            (error) => Effect.succeed<AdminOperationOutcome>(error),
          ),
        )
      })

    const threadReconcile = (raw: unknown): Effect.Effect<AdminOperationOutcome> =>
      Effect.flatMap(
        Schema.decodeUnknownEffect(ThreadReconcilePayload)(raw),
        (payload) => renderReconcile(payload),
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
      Effect.flatMap(
        Schema.decodeUnknownEffect(OperatorThreadCreatePayload)(payload),
        (input) => operatorThreadCreate(input),
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

    // Surfaces stored-vs-running divergence: writes persist immediately but
    // the warm DO keeps serving its boot-time config until rebuilt.
    let configMutatedAfterBoot = false
    const staleWarning = () =>
      configMutatedAfterBoot
        ? ' WARNING: stored config differs from the running handlers until the runtime rebuilds.'
        : ''
    const configGet: Effect.Effect<AdminOperationOutcome> = Effect.suspend(() =>
      Effect.succeed<AdminOperationOutcome>({
        ok: true,
        status: 200,
        body: {
          _tag: 'Success',
          summary: `${config._tag} ${config.environment} config (release ${configSummary.releaseId})${staleWarning()}`,
          configSummary,
          payload: config,
          ...(configMutatedAfterBoot ? { runningHandlersUseBootConfig: true } : {}),
        },
      }),
    )

    const configPut = (payload: unknown): Effect.Effect<AdminOperationOutcome> =>
      Effect.as(configStore.write(payload), {
        ok: true,
        status: 200,
        body: {
          _tag: 'Success',
          summary:
            'Runtime config persisted. The running handlers keep the boot-time config until the runtime rebuilds.',
        },
      } as AdminOperationOutcome).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            configMutatedAfterBoot = true
          }),
        ),
        Effect.catchIf(
          (error): error is KeyValueStore.KeyValueStoreError | Schema.SchemaError => true,
          (error) =>
            Effect.succeed<AdminOperationOutcome>(
              error._tag === 'KeyValueStoreError'
                ? {
                  ok: false,
                  status: 503,
                  body: {
                    _tag: 'ControlDependencyUnavailable',
                    dependency: 'runtime-config-store',
                    message: 'Config store write failed',
                  },
                }
                : {
                  ok: false,
                  status: 422,
                  body: { _tag: 'InvalidControlInput', message: 'Runtime config failed schema validation' },
                },
            ),
        ),
      )

    // Node parity: sync against the RUNNING config's command scope (staging
    // registers guild-scoped commands, production/global falls back to the
    // global scope) — never a hardcoded GlobalCommandScope.
    const commandsSync: Effect.Effect<AdminOperationOutcome> = syncApplicationCommands({
      token,
      scope: config.commandScope,
    }).pipe(
      Effect.map(commandsSyncOutcome),
      Effect.catchIf(
        (error): error is SyncApplicationCommandsError => true,
        (error) =>
          Effect.succeed<AdminOperationOutcome>({
            ok: false,
            status: 502,
            body: {
              _tag: 'ControlApplicationFailure',
              message: 'Application-command sync failed',
              reason: error._tag ?? 'unknown',
            },
          }),
      ),
    )

    return {
      supervisor: yield* makeSupervisorLoop(
        {
          acquire: makeShardAcquire({
            shard: shardLayout,
            connect: () => connectShard(token, rawStorage, rateLimitStore),
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
              : null),
          saveSession: (session) =>
            saveShardState(rawStorage, shardLayout, {
              resumeUrl: session.resumeUrl ?? '',
              sessionId: session.sessionId,
              sequence: session.sequence,
            }),
          clearSession: clearShardState(rawStorage, shardLayout),
        },
        { initialBackoff: '1 seconds', maxBackoff: '60 seconds' },
      ),
      journal,
      docsStore,
      config,
      configSummary,
      threadCreate,
      threadReconcile,
      runJournalMaintenance,
      configGet,
      configPut,
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
      let runtime: BotRuntime | undefined
      const gate = yield* makeSupervisorGate
      let lastError: string | undefined

      const ensureRuntime = Effect.suspend((): Effect.Effect<BotRuntime> => {
        if (runtime !== undefined) return Effect.succeed(runtime)
        // Secret reads stay lazy: the deploy phase evaluates this class with
        // placeholder bindings, so tokens resolve only at runtime.
        return Effect.map(buildRuntime(doState, env), (built) => {
          runtime = built
          return built
        })
      })
      const withRuntime = <A>(f: (rt: BotRuntime) => Effect.Effect<A>): Effect.Effect<A> =>
        Effect.flatMap(ensureRuntime, f)

      // Node parity (app.ts): the FIRST boot closes every pre-existing pending
      // claim as interrupted before any handler can observe it.
      let startupMaintenanceDone = false

      const tick: Effect.Effect<number | undefined> = Effect.gen(function* () {
        const rt = yield* ensureRuntime

        // Atomic claim BEFORE any yield (finding: two overlapping alarm/cron
        // ticks must never both fork the supervision loop). The stopped-state
        // check happens after claiming; a claimed-but-stopped slot releases.
        if ((yield* gate.tryBegin) === true) {
          if ((yield* rt.supervisor.state) === 'stopped') {
            yield* gate.end
            return undefined
          }
          lastError = undefined
          yield* Effect.forkDetach(rt.supervisor.run.pipe(
            // forkDetach is this Effect line's daemon fork (no forkDaemon
            // export); the loop's death would otherwise be invisible, so log
            // every abnormal exit and release the slot for re-forking.
            Effect.onExit((exit) =>
              exit._tag === 'Failure'
                ? Effect.sync(() => {
                  lastError = Cause.pretty(exit.cause)
                  console.error('[bot-state] supervision loop ended', lastError)
                })
                : Effect.void,
            ),
            Effect.ensuring(gate.end),
          ))
        }

        if (startupMaintenanceDone === false) {
          startupMaintenanceDone = true
          yield* rt.runJournalMaintenance('close-interrupted')
        } else {
          yield* rt.runJournalMaintenance('stale-only')
        }

        const delay = alarmDelayByState[yield* rt.supervisor.state]
        yield* delay === undefined
          ? Effect.promise(() => doState.raw.storage.deleteAlarm())
          : Effect.promise(() => doState.raw.storage.setAlarm(new Date(Date.now() + delay)))
        return delay
      })

      // A runtime that cannot build (corrupt stored config, dead journal) must
      // degrade /readyz to 503-with-cause instead of answering 500: report
      // schemaVersion 0 (readyz maps that to 503) plus the pretty cause.
      const degradedStatus = (causeText: string): BotStatus => ({
        supervisor: 'disconnected',
        hasSession: false,
        journalSchemaVersion: 0,
        docsMonthlySpentUsdMicros: 0,
        configSummary: encodeConfigSummary(makeDefaultRuntimeConfig()),
        lastError: causeText,
      })
      const status: Effect.Effect<BotStatus> = Effect.gen(function* () {
        const rt = yield* ensureRuntime
        const session = yield* loadShardState(doState.raw.storage, shardLayout)
        // An unmigrated/unreadable journal reports schemaVersion 0, which the
        // /readyz probe maps to 503 — migration failure must degrade here,
        // not surface as an unhandled 500.
        const settings = rt.migrationError._tag === 'Some'
          ? { schemaVersion: 0 }
          : yield* rt.journal.inspectStorage.pipe(
            Effect.catchIf(
              (_error): _error is JournalUnavailableError => true,
              () => Effect.succeed({ schemaVersion: 0 }),
            ),
          )
        return {
          supervisor: yield* rt.supervisor.state,
          hasSession: session !== undefined && session.sessionId !== '',
          journalSchemaVersion: settings.schemaVersion,
          docsMonthlySpentUsdMicros: yield* rt.docsStore.monthlySpent(Date.now()),
          configSummary: rt.configSummary,
          lastError,
        }
      }).pipe(Effect.catchCause((cause) => Effect.succeed(degradedStatus(Cause.pretty(cause)))))

      return {
        tick: () => tick,

        status: () => status,

        threadCreate: (payload: unknown) => withRuntime((rt) => rt.threadCreate(payload)),

        threadReconcile: (payload: unknown) => withRuntime((rt) => rt.threadReconcile(payload)),

        configGet: () => withRuntime((rt) => rt.configGet),

        configPut: (payload: unknown) => withRuntime((rt) => rt.configPut(payload)),

        commandsSync: () => withRuntime((rt) => rt.commandsSync),

        /** Cloudflare DO alarm entry point — the same heartbeat as `tick`. */
        alarm: () => tick,
      }
    })
  }),
) {}

