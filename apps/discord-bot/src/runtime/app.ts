import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { NodeHttpClient, NodeSocket } from '@effect/platform-node'
import { Discord, DiscordConfig, DiscordREST } from 'dfx'
import type { GatewayLifecycleEvent } from 'dfx/DiscordGateway'
import { DiscordGateway, DiscordLive } from 'dfx/gateway'
import { Context, Deferred, Effect, Fiber, Layer, Redacted, Ref, Schema, Stream } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import {
  desiredApplicationCommands,
  makeApplicationCommandsReconciler,
  makeDfxApplicationCommandsPort,
  type ApplicationCommandsPort,
} from '../application-commands/index.ts'
import {
  DiscordActions,
  DiscordActionsDfxLive,
  DiscordEventHandlers,
  makeDfxThreadMutation,
  runDiscordRoutes,
} from '../discord/index.ts'
import { assessDfxTerminalCloseAdmission } from '../discord/terminal-close.ts'
import {
  DocsTelemetry,
  DocsWorkflow,
  makeDocsWorkflowLayer,
  docsAdmissionLimitsFromDeployment,
  makeCanonicalCorpusLayer,
  makeFileDocsStateStore,
  makeFileDocsTelemetry,
  makeOpenAiAnswerEngineLayer,
  makeOpenAiProviderReadinessPort,
  lunaCostUsdMicros,
  admitDocsProvider,
  correlateWithKey,
} from '../docs/index.ts'
import type { ThreadActionJournalService } from '../journal/service.ts'
import { makeSqliteThreadActionJournal } from '../journal/sqlite.ts'
import {
  makeDfxThreadObservation,
  makeThreadReconciliationWorkflow,
  type ThreadObservationPort,
} from '../reconciliation/index.ts'
import { makeOpenAiThreadTitlePort, makeThreadWorkflow, type ThreadTitlePort } from '../threading/index.ts'
import { acquireActionAuthority } from './authority-lock.ts'
import type { RuntimeConfigPayload } from './config.ts'
import { makeLocalBotControl, serveBotControl } from './control.ts'
import { FakeDiscordActionsLive, FakeDocsPortsLive, fakeThreadMutation } from './fake-ports.ts'
import { applyGatewayLifecycle, initialGatewayReadiness, isGatewayReady } from './gateway-readiness.ts'
import { DocsChannelResolutionError, makeDiscordEventHandlersLayer } from './handlers.ts'
import { deriveRuntimeState, initialHealthState, isReady, serveHealth, type RuntimeHealthState } from './health.ts'
import {
  makeDfxOperatorSourceReader,
  makeJournalReconciliation,
  OperatorSourceTransportError,
  type OperatorSourceReader,
} from './threading-adapter.ts'

export interface RuntimeHandle {
  readonly healthPort: number
  readonly health: Ref.Ref<RuntimeHealthState>
  readonly eventHandlers: typeof DiscordEventHandlers.Service
  readonly failure: Effect.Effect<never, RuntimeGatewayFailure>
}

export class DiscordIdentityAdmissionError extends Schema.TaggedError<DiscordIdentityAdmissionError>()(
  'DiscordIdentityAdmissionError',
  { expectedApplicationId: Schema.String, message: Schema.String },
) {}

class RuntimeSecretFileError extends Schema.TaggedError<RuntimeSecretFileError>()('RuntimeSecretFileError', {
  name: Schema.String,
  message: Schema.String,
}) {}

export class RuntimeGatewayFailure extends Schema.TaggedError<RuntimeGatewayFailure>()('RuntimeGatewayFailure', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class GatewayReadinessError extends Schema.TaggedError<GatewayReadinessError>()('GatewayReadinessError', {
  reason: Schema.Literals(['stream_ended', 'terminal_failure']),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const FakeDocsWorkflowLive = makeDocsWorkflowLayer().pipe(Layer.provide(FakeDocsPortsLive))
const FakeServiceLayer = Layer.merge(FakeDiscordActionsLive, FakeDocsWorkflowLive)

/** The only Gateway intents admitted by LSC.APP.DISCORD.RT-R03. */
export const gatewayIntents =
  Discord.GatewayIntentBits.Guilds | Discord.GatewayIntentBits.GuildMessages | Discord.GatewayIntentBits.MessageContent

/** Acquires the complete fake-composable tracer bullet in one Effect scope. */
export const acquireRuntime = Effect.fn('runtime.acquire')(function* (
  config: RuntimeConfigPayload,
  configPath: string,
) {
  const health = yield* Ref.make<RuntimeHealthState>(initialHealthState(config.environment, config.releaseId))
  yield* acquireActionAuthority(config.stateDirectory)
  yield* Ref.update(health, (current) => ({ ...current, actionAuthority: true }))

  const journal = yield* makeSqliteThreadActionJournal({ path: join(config.stateDirectory, 'thread-actions.sqlite') })
  yield* journal.inspectStorage
  yield* Ref.update(health, (current) => ({ ...current, journal: true }))

  const services = config._tag === 'fake' ? yield* makeFakeServices : yield* makeRealServices(config)
  yield* Ref.update(health, (current) => ({
    ...current,
    identityVerified: services.identityVerified,
    restProbe: services.restProbe,
    lastRestProbeAt: new Date().toISOString(),
  }))
  const gatewayFailure =
    services.gateway === undefined
      ? undefined
      : yield* services.gateway.failure.pipe(
          Effect.mapError(
            (error) => new RuntimeGatewayFailure({ message: 'Discord gateway terminated', cause: error }),
          ),
          Effect.tapError(() =>
            Ref.update(health, (current) => ({
              ...current,
              state: 'terminal' as const,
              gateway: 'fatal' as const,
              terminalErrorClass: 'TerminalGatewayCloseError',
              lastGatewayActivityAt: new Date().toISOString(),
            })),
          ),
          Effect.forkScoped,
        )
  // Subscribe at the first instant the acquired DFX service is visible. DFX
  // does not replay READY, so delaying this until after recovery could miss it.
  const gatewayReady =
    services.gateway === undefined
      ? undefined
      : yield* awaitGatewayReady(services.gateway, health).pipe(Effect.orDie, Effect.forkScoped)

  const thread = makeThreadWorkflow(
    {
      reconciliation: makeJournalReconciliation(journal),
      mutation: services.mutation,
      title: services.title,
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
  const reconcile = makeThreadReconciliationWorkflow(journal, services.observer)

  // No handler is registered until every pre-existing pending claim has been
  // closed. This makes "pending at startup" proof of an interrupted process,
  // never a live request that recovery could race.
  yield* runJournalMaintenance(journal, reconcile, health, 'close-interrupted')

  const eventHandlers = yield* DiscordEventHandlers.pipe(
    Effect.provide(
      makeDiscordEventHandlersLayer(
        config,
        services.resolveDocsChannelParent === undefined
          ? { thread, docsReady: services.docsReady }
          : { thread, docsReady: services.docsReady, resolveDocsChannelParent: services.resolveDocsChannelParent },
      ).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(DiscordActions, services.actions), Layer.succeed(DocsWorkflow, services.docs)),
        ),
      ),
    ),
  )
  if (services.gateway !== undefined) {
    yield* runDiscordRoutes.pipe(
      Effect.provideService(DiscordGateway, services.gateway),
      Effect.provideService(DiscordEventHandlers, eventHandlers),
    )
  }
  if (gatewayReady !== undefined) yield* Fiber.join(gatewayReady)
  yield* Ref.update(health, (current) => {
    const next = {
      ...current,
      docsReady: services.docsReady,
      handlersRegistered: true,
      gateway: 'ready' as const,
      lastGatewayActivityAt: new Date().toISOString(),
    }
    return { ...next, state: deriveRuntimeState(next) }
  })

  const maintenance = runJournalMaintenance(journal, reconcile, health, 'stale-only')
  yield* Effect.sleep('1 minute').pipe(
    Effect.andThen(
      maintenance.pipe(Effect.catchCause(() => Effect.logError('Discord journal maintenance iteration failed'))),
    ),
    Effect.forever,
    Effect.forkScoped,
  )

  const control = makeLocalBotControl({
    config,
    configPath,
    health,
    journal,
    docs: services.docs,
    sourceReader: services.sourceReader,
    sourceObserver: services.observer,
    thread,
    reconcile,
    commands: services.commands,
  })
  yield* serveBotControl(config.controlSocketPath, control, {
    environment: config.environment,
    mode: config._tag,
  })
  const healthServer = yield* serveHealth(health, config.health.host, config.health.port)
  const readyHealth: RuntimeHealthState = {
    state: 'ready',
    actionAuthority: true,
    journal: true,
    environment: config.environment,
    releaseId: config.releaseId,
    identityVerified: services.identityVerified,
    restProbe: services.restProbe,
    handlersRegistered: true,
    docsReady: services.docsReady,
    gateway: 'ready',
    lastGatewayActivityAt: new Date().toISOString(),
  }
  yield* Ref.update(health, (current) =>
    current.state === 'terminal' ? current : { ...readyHealth, state: deriveRuntimeState(readyHealth) },
  )

  const failure = gatewayFailure === undefined ? Effect.never : Fiber.join(gatewayFailure)
  return { healthPort: healthServer.port, health, eventHandlers, failure } satisfies RuntimeHandle
})

export const runRuntime = (config: RuntimeConfigPayload, configPath: string) =>
  Effect.gen(function* () {
    const handle = yield* acquireRuntime(config, configPath).pipe(Effect.orDie)
    yield* Effect.logInfo(
      `LiveStore Discord bot ready environment=${config.environment} mode=${config._tag} healthPort=${handle.healthPort}`,
    )
    return yield* handle.failure
  })

const makeFakeServices = Effect.gen(function* () {
  const services = yield* Effect.gen(function* () {
    return { actions: yield* DiscordActions, docs: yield* DocsWorkflow }
  }).pipe(Effect.provide(FakeServiceLayer))
  const title: ThreadTitlePort = {
    propose: (input) => Effect.succeed([...input].slice(0, 100).join('')),
  }
  const observer: ThreadObservationPort = {
    observeSourceThread: () => Effect.succeed({ _tag: 'Absent' }),
  }
  const commandPort: ApplicationCommandsPort = {
    list: () => Effect.succeed(desiredApplicationCommands),
    replace: (_scope, commands) => Effect.succeed(commands),
  }
  const sourceReader: OperatorSourceReader = {
    read: () =>
      Effect.succeed({
        messageKind: 'Default',
        hasMessageReference: false,
        authorKind: 'Human',
        content: 'Fake operator source message',
        attachmentCount: 0,
        hasPoll: false,
        stickerCount: 0,
      }),
  }
  return {
    ...services,
    title,
    observer,
    commands: makeApplicationCommandsReconciler(commandPort),
    sourceReader,
    gateway: undefined,
    mutation: fakeThreadMutation,
    docsReady: true,
    resolveDocsChannelParent: undefined,
    identityVerified: true,
    restProbe: 'ok' as const,
  }
})

const makeRealServices = (config: Extract<RuntimeConfigPayload, { readonly _tag: 'real' }>) =>
  Effect.gen(function* () {
    yield* assessDfxTerminalCloseAdmission
    const discordToken = yield* readSecretFile(config.credentials.discordTokenFile, 'Discord token')
    const openAiApiKey = yield* readSecretFile(config.credentials.openAiApiKeyFile, 'OpenAI API key')
    const correlationKeyPath = config.credentials.docsCorrelationKeyFile
    const correlationKey = yield* readSecretFile(correlationKeyPath, 'Docs correlation key')
    // The title port captures HttpClient, so build it in the runtime scope rather
    // than returning a service from a prematurely released provided layer.
    const titleHttpContext = yield* Layer.build(NodeHttpClient.layerUndici)
    const title = yield* makeOpenAiThreadTitlePort({ apiKey: openAiApiKey }).pipe(
      Effect.provideService(HttpClient.HttpClient, Context.get(titleHttpContext, HttpClient.HttpClient)),
    )
    const discordBase = DiscordActionsDfxLive.pipe(
      Layer.provideMerge(DiscordLive),
      Layer.provide(
        DiscordConfig.layer({
          token: discordToken,
          gateway: {
            intents: gatewayIntents,
          },
        }),
      ),
      Layer.provide(NodeSocket.layerWebSocketConstructor),
      Layer.provide(NodeHttpClient.layerUndici),
    )
    const docsPorts = Layer.mergeAll(
      makeCanonicalCorpusLayer(),
      makeOpenAiAnswerEngineLayer({ apiKey: openAiApiKey }),
      Layer.succeed(DocsTelemetry, DocsTelemetry.of(makeFileDocsTelemetry(config.stateDirectory))),
    ).pipe(Layer.provide(NodeHttpClient.layerUndici))
    const docsLayer = makeDocsWorkflowLayer({
      limits: docsAdmissionLimitsFromDeployment(config.openAi.limits),
      monthlyCostUsdMicros: config.openAi.limits.monthlyCostUsdMicros,
      stateStore: makeFileDocsStateStore(config.stateDirectory),
      correlationKey: Redacted.value(correlationKey),
      correlatePrincipal: (value) => correlateWithKey(Redacted.value(correlationKey), value),
      estimatedCostUsdMicros: (usage) => lunaCostUsdMicros(usage),
    }).pipe(Layer.provideMerge(docsPorts))
    const context = yield* Layer.build(Layer.merge(discordBase, docsLayer))
    const rest = Context.get(context, DiscordREST)
    yield* verifyDiscordApplicationIdentity(
      {
        getMyOauth2Application: () =>
          rest
            .getMyOauth2Application()
            .pipe(
              Effect.mapError(
                (cause) => new DiscordIdentityReadError({ message: 'Discord identity request failed', cause }),
              ),
            ),
      },
      config.applicationId,
    )
    const readiness = makeOpenAiProviderReadinessPort({ apiKey: openAiApiKey, projectId: config.openAi.projectId })(
      Context.get(titleHttpContext, HttpClient.HttpClient),
    )
    const docsReady = yield* admitDocsProvider(readiness, {
      projectId: config.openAi.projectId,
      model: 'gpt-5.6-luna',
    }).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))
    return {
      actions: Context.get(context, DiscordActions),
      docs: Context.get(context, DocsWorkflow),
      title,
      observer: makeDfxThreadObservation(rest),
      commands: makeApplicationCommandsReconciler(makeDfxApplicationCommandsPort(rest)),
      sourceReader: makeDfxOperatorSourceReader({
        getMessage: (channelId, messageId) =>
          rest
            .getMessage(channelId, messageId)
            .pipe(
              Effect.mapError(
                (cause) => new OperatorSourceTransportError({ message: 'Discord source message request failed' }),
              ),
            ),
      }),
      gateway: Context.get(context, DiscordGateway),
      mutation: makeDfxThreadMutation(rest),
      docsReady,
      identityVerified: true,
      restProbe: 'ok' as const,
      resolveDocsChannelParent: ({ guildId, channelId }: { guildId: string; channelId: string }) =>
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
        ),
    }
  })

const readSecretFile = (path: string, name: string) =>
  Effect.tryPromise({
    try: async () => {
      const value = (await readFile(path, 'utf8')).trim()
      if (value.length === 0) throw new Error(`${name} file is empty`)
      return Redacted.make(value)
    },
    catch: () => new RuntimeSecretFileError({ name, message: `${name} file could not be read` }),
  })

/** Readiness follows Discord's READY dispatch, not allocated shard objects. */
export const awaitGatewayReady = (gateway: typeof DiscordGateway.Service, health?: Ref.Ref<RuntimeHealthState>) =>
  gateway.shards.pipe(
    Effect.flatMap((shards) =>
      awaitGatewayReadySignal(
        gateway.lifecycle,
        gateway.failure.pipe(
          Effect.mapError(
            (error) =>
              new GatewayReadinessError({
                reason: 'terminal_failure',
                message: 'Discord gateway terminated',
                cause: error,
              }),
          ),
        ),
        new Set([...shards].map((shard) => shard.id[0])),
        health,
      ),
    ),
  )

export const awaitGatewayReadySignal = Effect.fn('runtime.discord.awaitReady')(function* (
  lifecycle: Stream.Stream<unknown, never, never>,
  failure: Effect.Effect<never, GatewayReadinessError, never>,
  expectedShardIds: Iterable<number> = [],
  health?: Ref.Ref<RuntimeHealthState>,
) {
  const stateRef = yield* Ref.make(initialGatewayReadiness(expectedShardIds))
  const readySignal = yield* Deferred.make<void, GatewayReadinessError>()
  const observer = yield* Effect.forkChild(
    Stream.runForEach(lifecycle, (rawEvent) =>
      Effect.gen(function* () {
        const event = decodeGatewayLifecycleEvent(rawEvent)
        if (event === undefined) return
        const next = yield* Ref.updateAndGet(stateRef, (state) => applyGatewayLifecycle(state, event))
        if (health !== undefined) {
          yield* Ref.update(health, (current) => {
            const next = {
              ...current,
              gateway:
                event._tag === 'Ready' || event._tag === 'Resumed'
                  ? ('ready' as const)
                  : event._tag === 'Connecting'
                    ? ('connecting' as const)
                    : event._tag === 'Disconnected'
                      ? ('disconnected' as const)
                      : current.gateway,
              lastGatewayActivityAt: new Date().toISOString(),
            }
            return { ...next, state: deriveRuntimeState(next) }
          })
        }
        if (isGatewayReady(next) === true) yield* Deferred.succeed(readySignal, void 0)
      }),
    ).pipe(
      Effect.andThen(
        Deferred.fail(
          readySignal,
          new GatewayReadinessError({ reason: 'stream_ended', message: 'Gateway lifecycle stream ended before READY' }),
        ),
      ),
    ),
  )
  yield* Effect.raceFirst(Deferred.await(readySignal), failure).pipe(Effect.ensuring(Fiber.interrupt(observer)))
})

const decodeGatewayLifecycleEvent = (value: unknown): GatewayLifecycleEvent | undefined => {
  if (typeof value !== 'object' || value === null || !('_tag' in value) || !('shardId' in value)) return undefined
  const record = value as Record<string, unknown>
  const tag = record._tag
  const shardId = record.shardId
  if (
    typeof tag !== 'string' ||
    typeof shardId !== 'number' ||
    Number.isInteger(shardId) === false ||
    Number.isFinite(shardId) === false ||
    shardId < 0
  )
    return undefined
  if (tag === 'Connecting' || tag === 'Ready' || tag === 'Resumed') return { _tag: tag, shardId }
  if (tag === 'Disconnected' && record.retryable === true) {
    return {
      _tag: tag,
      shardId,
      retryable: true,
      ...(typeof record.code === 'number' && Number.isFinite(record.code) === true ? { code: record.code } : {}),
    }
  }
  return undefined
}

const runJournalMaintenance = (
  journal: ThreadActionJournalService,
  reconcile: ReturnType<typeof makeThreadReconciliationWorkflow>,
  health: Ref.Ref<RuntimeHealthState>,
  pendingPolicy: 'stale-only' | 'close-interrupted',
) =>
  Effect.gen(function* () {
    const now = Date.now()
    const result = yield* reconcile({
      selection: { _tag: 'All', limit: 100 },
      mode: { _tag: 'Apply', reason: 'runtime bounded recovery' },
      now,
      pendingPolicy,
    })
    yield* journal.deleteExpiredTerminal({ now })
    yield* Ref.update(health, (current) => {
      const next = {
        ...current,
        journal: true,
      }
      return { ...next, state: deriveRuntimeState(next) }
    })
    if (result.truncated === true) yield* Effect.logWarning('Discord journal recovery batch was truncated')
  }).pipe(
    Effect.tapError(() =>
      Ref.update(
        health,
        (current): RuntimeHealthState => ({
          ...current,
          journal: false,
          state: 'starting',
        }),
      ),
    ),
    Effect.withSpan('runtime.journal.maintenance'),
    Effect.orDie,
  )

interface IdentityRest {
  readonly getMyOauth2Application: () => Effect.Effect<{ readonly id: string }, DiscordIdentityReadError>
}

export class DiscordIdentityReadError extends Schema.TaggedError<DiscordIdentityReadError>()(
  'DiscordIdentityReadError',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** Verifies the token's application identity before mutation handlers exist. */
export const verifyDiscordApplicationIdentity = (rest: IdentityRest, expectedApplicationId: string) =>
  rest.getMyOauth2Application().pipe(
    Effect.mapError(
      () =>
        new DiscordIdentityAdmissionError({
          expectedApplicationId,
          message: 'Discord application identity could not be verified',
        }),
    ),
    Effect.flatMap((application) =>
      application.id === expectedApplicationId
        ? Effect.void
        : Effect.fail(
            new DiscordIdentityAdmissionError({
              expectedApplicationId,
              message: 'Discord token application identity does not match runtime config',
            }),
          ),
    ),
    Effect.withSpan('runtime.discord.verifyApplicationIdentity'),
  )
