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
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'
import { layerWebSocketConstructorGlobal, WebSocketConstructor } from 'effect/unstable/socket/Socket'

import { DiscordConfig, type DiscordConfigService } from 'dfx/DiscordConfig'
import { JsonDiscordWSCodecLive } from 'dfx/DiscordGateway/DiscordWS'
import { Shard, ShardLive, type RunningShard } from 'dfx/DiscordGateway/Shard'
import { ShardStateStore } from 'dfx/DiscordGateway/Shard/StateStore'
import { MemoryRateLimitStoreLive, RateLimitStore, type RateLimitStoreService } from 'dfx/RateLimit'

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
import { gatewayIntents } from '../../src/discord/events.ts'
import type { DocsStateStore } from '../../src/docs/state.ts'
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
  /** Last fatal supervision-loop error message, when one was recorded. */
  readonly lastError: string | undefined
}

interface BotRuntime {
  readonly supervisor: Supervisor
  readonly journal: ThreadActionJournalService
  readonly docsStore: DocsStateStore
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
 * attempt, so socket fibers finalize the moment an attempt ends.
 */
const connectShard = (
  token: string,
  rawStorage: DurableObjectStorage,
  rateLimitStore: RateLimitStoreService,
): Effect.Effect<RunningShard, unknown, Scope.Scope> =>
  ShardLive.pipe(
    Layer.provide(JsonDiscordWSCodecLive),
    // The store is built ONCE per BotState instance and shared into every
    // attempt: a per-attempt memory store would wipe identify rate-limit
    // state between attempts after disconnect storms (Discord's global
    // IDENTIFY budget is exactly what it protects).
    Layer.provide(Layer.effect(RateLimitStore, Effect.succeed(rateLimitStore))),
    Layer.provide(Layer.succeed(DiscordConfig, discordConfigService(token))),
    Layer.provide(shardStoreLayerFor(rawStorage)),
    Layer.build,
    Effect.flatMap((context) => Context.get(context, Shard).connect([...shardLayout])),
    Effect.provide(layerWebSocketConstructorGlobal),
  )

/**
 * Assembles the durable runtime once per BotState instance: SQLite journal
 * client (full storage handle — `withTransaction` breaks on bare `.sql`),
 * docs quota store over key/value storage, and the supervisor wired to the
 * dfx shard through shared session keys.
 */
const buildRuntime = (doState: DoInstanceState, token: string): Effect.Effect<BotRuntime> =>
  Effect.gen(function* () {
    const rawStorage = doState.raw.storage

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
    return {
      supervisor: yield* makeSupervisorLoop(
        {
          acquire: makeShardAcquire({
            shard: shardLayout,
            connect: () => connectShard(token, rawStorage, rateLimitStore),
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
      journal: makeSqliteDoThreadActionJournal(client, crypto),
      docsStore: makeKeyValueDocsStateStore(keyValueStoreFromDurableStorage(rawStorage), crypto),
      migrationError,
    }
  })

/**
 * BotState — the single durable object holding ALL durable bot state:
 * SQLite thread-action journal (DO SQL storage), dfx-compatible shard session
 * state and docs quota/provenance state (both over DO key/value storage), and
 * the gateway supervision loop. One instance ("gateway") drives the live
 * session; alarms keep supervision alive across isolate recycles.
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
        return Effect.map(buildRuntime(doState, readSecret(env, 'DISCORD_BOT_TOKEN')), (built) => {
          runtime = built
          return built
        })
      })

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

        const delay = alarmDelayByState[yield* rt.supervisor.state]
        yield* delay === undefined
          ? Effect.promise(() => doState.raw.storage.deleteAlarm())
          : Effect.promise(() => doState.raw.storage.setAlarm(new Date(Date.now() + delay)))
        return delay
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
          lastError,
        }
      })

      return {
        tick: () => tick,

        status: () => status,

        /** Cloudflare DO alarm entry point — the same heartbeat as `tick`. */
        alarm: () => tick,
      }
    })
  }),
) {}
