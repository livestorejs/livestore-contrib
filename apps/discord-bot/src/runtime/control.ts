import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'

import { Cause, Effect, Exit, Option, Ref, Schema } from 'effect'
import { RpcClient } from 'effect/unstable/rpc'
import type { RpcGroup } from 'effect/unstable/rpc'
import type { FromServer } from 'effect/unstable/rpc/RpcMessage'

import type { makeApplicationCommandsReconciler } from '../application-commands/index.ts'
import { BotControl, type BotControlClient, type BotControlOperation } from '../control/contract.ts'
import {
  ControlAmbiguousOutcome,
  ControlApplicationFailure,
  ControlAuthorizationRejected,
  ControlDependencyUnavailable,
  ControlError,
  ControlGateUnrun,
  ControlResult,
  DeploymentEnvironment,
  DiscordMessageRef,
  OperatorReason,
  type ControlError as ControlErrorType,
  type ControlResult as ControlResultType,
  type DeploymentEnvironment as DeploymentEnvironmentType,
  type DiscordMessageRef as DiscordMessageRefType,
  type OperatorReason as OperatorReasonType,
} from '../control/schema.ts'
import { DocsWorkflow, renderDocsResult, type DocsWorkflowService } from '../docs/index.ts'
import type { ThreadActionJournalService } from '../journal/service.ts'
import type { ReconciliationError, ReconciliationResult } from '../reconciliation/index.ts'
import type { ThreadObservationPort } from '../reconciliation/port.ts'
import { classifyIntentionalSource, EnvironmentName, type ThreadOutcome } from '../threading/index.ts'
import type { RuntimeConfigPayload } from './config.ts'
import { loadRuntimeConfig, summarizeConfig } from './config.ts'
import type { RuntimeHealthState } from './health.ts'
import { isReady } from './health.ts'
import { candidateForOperator, type OperatorSourceReader } from './threading-adapter.ts'

const RequestEnvelope = Schema.Struct({
  apiVersion: Schema.Literal(1),
  id: Schema.String,
  operation: Schema.String,
  payload: Schema.Unknown,
})
const SuccessEnvelope = Schema.Struct({ apiVersion: Schema.Literal(1), id: Schema.String, result: ControlResult })
const FailureEnvelope = Schema.Struct({ apiVersion: Schema.Literal(1), id: Schema.String, error: ControlError })
const ResponseEnvelope = Schema.Union([SuccessEnvelope, FailureEnvelope])
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestEnvelope), { onExcessProperty: 'error' })
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(ResponseEnvelope), { onExcessProperty: 'error' })
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(ResponseEnvelope))
const maximumRequestBytes = 1024 * 1024

export interface ControlRuntime {
  readonly client: BotControlClient
}

export interface ControlHandlers {
  readonly invoke: (
    operation: BotControlOperation,
    payload: unknown,
    principal: ControlPrincipal,
  ) => Effect.Effect<ControlResultType, ControlErrorType>
}

export interface ControlPrincipal {
  readonly id: string
  readonly provenance: 'peer-credentials' | 'filesystem-policy' | 'fake-runtime'
  readonly canRead: boolean
  readonly canWrite: boolean
}

export interface ControlSocketPolicy {
  readonly environment: RuntimeConfigPayload['environment']
  readonly mode: RuntimeConfigPayload['_tag']
}

class ControlSocketInspectionError extends Schema.TaggedError<ControlSocketInspectionError>()(
  'ControlSocketInspectionError',
  { message: Schema.String },
) {}

export const makeLocalBotControl = (options: {
  readonly config: RuntimeConfigPayload
  readonly configPath: string
  readonly health: Ref.Ref<RuntimeHealthState>
  readonly journal: ThreadActionJournalService
  readonly docs: DocsWorkflowService
  readonly sourceReader: OperatorSourceReader
  readonly sourceObserver: ThreadObservationPort
  readonly thread: (candidate: ReturnType<typeof candidateForOperator>) => Effect.Effect<ThreadOutcome>
  readonly reconcile: (input: {
    readonly selection:
      | { readonly _tag: 'One'; readonly sourceMessageId: DiscordMessageRefType['messageId'] }
      | {
          readonly _tag: 'All'
          readonly state?: 'creating' | 'unknown_external'
          readonly limit?: number
        }
    readonly mode: { readonly _tag: 'Plan' } | { readonly _tag: 'Apply'; readonly reason: string }
    readonly now: number
  }) => Effect.Effect<ReconciliationResult, ReconciliationError>
  readonly commands: ReturnType<typeof makeApplicationCommandsReconciler>
}): ControlHandlers => {
  const unsupported = (message: string) => Effect.fail(new ControlGateUnrun({ message }))
  const inspect = (source: DiscordMessageRefType) =>
    options.journal.get(source.messageId).pipe(
      Effect.mapError(
        () => new ControlDependencyUnavailable({ dependency: 'journal', message: 'Action journal is unavailable' }),
      ),
      Effect.map((record) =>
        success(
          record === undefined
            ? 'No action journal record exists.'
            : `state=${record.state} thread=${record.threadId ?? 'none'} outcome=${record.outcomeCode ?? 'none'}`,
        ),
      ),
    )
  const create = (
    input: {
      readonly source: DiscordMessageRefType
      readonly environment: DeploymentEnvironmentType
      readonly reason: OperatorReasonType
      readonly name?: string
    },
    principal: ControlPrincipal,
  ) => {
    if (input.environment !== options.config.environment) {
      return Effect.fail(
        new ControlApplicationFailure({ message: 'Requested environment does not match the running bot' }),
      )
    }
    if (
      input.source.guildId !== options.config.guildId ||
      options.config.actionChannelIds.includes(input.source.channelId) === false
    ) {
      return Effect.fail(
        new ControlApplicationFailure({ message: 'Requested source is outside the configured guild/channel scope' }),
      )
    }
    return options.sourceReader.read(input.source).pipe(
      Effect.mapError((error) =>
        error.kind === 'unavailable'
          ? new ControlDependencyUnavailable({ dependency: 'discord-source-read', message: error.message })
          : new ControlApplicationFailure({ message: error.message }),
      ),
      Effect.flatMap((facts) =>
        options.sourceObserver
          .observeSourceThread({
            sourceMessageId: input.source.messageId,
            channelId: input.source.channelId,
          })
          .pipe(
            Effect.mapError(
              () =>
                new ControlDependencyUnavailable({
                  dependency: 'discord-thread-observation',
                  message: 'Existing source thread could not be authoritatively checked',
                }),
            ),
            Effect.flatMap((observation) =>
              observation._tag === 'Unrun'
                ? Effect.fail(
                    new ControlDependencyUnavailable({
                      dependency: 'discord-thread-observation',
                      message: 'Existing source thread could not be authoritatively checked',
                    }),
                  )
                : options.thread(
                    candidateForOperator(
                      input.source,
                      Schema.decodeUnknownSync(EnvironmentName)(options.config.environment),
                      input.name,
                      input.reason,
                      principal.id,
                      principal.canWrite,
                      observation._tag === 'ExactSourceThread'
                        ? { ...facts, existingThreadId: observation.threadId }
                        : facts,
                    ),
                  ),
            ),
          ),
      ),
      Effect.flatMap(controlResultFromThreadOutcome),
    )
  }

  return {
    invoke: (operation, payload, principal) => {
      try {
        if (principal.canRead === false) {
          return Effect.fail(
            new ControlAuthorizationRejected({
              message: 'Control transport could not prove an authorized operator principal',
            }),
          )
        }
        if (isWriteOperation(operation, payload) === true && principal.canWrite === false) {
          return Effect.fail(
            new ControlAuthorizationRejected({
              message: 'Control transport could not prove an authorized operator principal for this write',
            }),
          )
        }
        switch (operation) {
          case 'ThreadInspect':
            return inspect(decodeSource(payload).source)
          case 'ThreadPlan': {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({ source: DiscordMessageRef, name: Schema.optional(Schema.String), noAi: Schema.Boolean }),
            )(payload)
            if (
              input.source.guildId !== options.config.guildId ||
              options.config.actionChannelIds.includes(input.source.channelId) === false
            ) {
              return Effect.fail(
                new ControlApplicationFailure({
                  message: 'Requested source is outside the configured guild/channel scope',
                }),
              )
            }
            return options.sourceReader.read(input.source).pipe(
              Effect.mapError((error) =>
                error.kind === 'unavailable'
                  ? new ControlDependencyUnavailable({ dependency: 'discord-source-read', message: error.message })
                  : new ControlApplicationFailure({ message: error.message }),
              ),
              Effect.flatMap((facts) =>
                options.sourceObserver
                  .observeSourceThread({
                    sourceMessageId: input.source.messageId,
                    channelId: input.source.channelId,
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new ControlDependencyUnavailable({
                          dependency: 'discord-thread-observation',
                          message: 'Existing source thread could not be authoritatively checked',
                        }),
                    ),
                    Effect.flatMap((observation) => {
                      if (observation._tag === 'Unrun')
                        return Effect.fail(
                          new ControlDependencyUnavailable({
                            dependency: 'discord-thread-observation',
                            message: 'Existing source thread could not be authoritatively checked',
                          }),
                        )
                      const candidate = candidateForOperator(
                        input.source,
                        Schema.decodeUnknownSync(EnvironmentName)(options.config.environment),
                        input.name,
                        'operator plan',
                        'operator',
                        true,
                        observation._tag === 'ExactSourceThread'
                          ? { ...facts, existingThreadId: observation.threadId }
                          : facts,
                      )
                      const reason = classifyIntentionalSource(candidate, {
                        environment: options.config.environment,
                        guildId: options.config.guildId,
                        parentChannelIds: new Set(options.config.actionChannelIds),
                        admittedParentKinds: new Set(['GuildText', 'GuildAnnouncement']),
                        legacyCommands: new Set(options.config.legacyCommands),
                      })
                      return Effect.succeed(
                        success(
                          reason === undefined
                            ? `Source ${input.source.channelId}/${input.source.messageId} read and policy accepted; ${observation._tag === 'ExactSourceThread' ? 'existing thread will be reused' : 'a thread may be created'}.`
                            : `Source ${input.source.channelId}/${input.source.messageId} read and policy rejected: ${reason}.`,
                          'Planned',
                        ),
                      )
                    }),
                  ),
              ),
            )
          }
          case 'ThreadCreate': {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                source: DiscordMessageRef,
                environment: DeploymentEnvironment,
                apply: Schema.Literal(true),
                reason: OperatorReason,
                name: Schema.optional(Schema.String),
              }),
            )(payload)
            const base = { source: input.source, environment: input.environment, reason: input.reason }
            return input.name === undefined ? create(base, principal) : create({ ...base, name: input.name }, principal)
          }
          case 'ThreadStatus':
            return inspect(decodeSource(payload).source)
          case 'ThreadReconcile': {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                source: Schema.optional(DiscordMessageRef),
                all: Schema.Boolean,
                state: Schema.optional(Schema.Literals(['creating', 'unknown_external'])),
                limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
                apply: Schema.Boolean,
                environment: Schema.optional(DeploymentEnvironment),
                reason: Schema.optional(OperatorReason),
              }),
            )(payload)
            if (input.all === (input.source !== undefined)) {
              return Effect.fail(new ControlApplicationFailure({ message: 'Choose exactly one source or --all' }))
            }
            if (
              input.apply === true &&
              (input.environment !== options.config.environment || input.reason === undefined)
            ) {
              return Effect.fail(
                new ControlApplicationFailure({
                  message: 'Apply requires the running environment and an operator reason',
                }),
              )
            }
            const selection =
              input.all === true
                ? {
                    _tag: 'All' as const,
                    ...(input.state === undefined ? {} : { state: input.state }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                  }
                : { _tag: 'One' as const, sourceMessageId: input.source!.messageId }
            const mode =
              input.apply === true ? { _tag: 'Apply' as const, reason: input.reason! } : { _tag: 'Plan' as const }
            return options.reconcile({ selection, mode, now: Date.now() }).pipe(
              Effect.map(renderReconciliationResult(input.apply)),
              Effect.mapError(() => new ControlApplicationFailure({ message: 'Thread reconciliation failed' })),
            )
          }
          case 'ThreadPolicyExplain': {
            const input = decodeSource(payload)
            return Effect.succeed(
              success(
                options.config.actionChannelIds.includes(input.source.channelId) === true
                  ? 'Source parent channel is configured; automatic content facts require message retrieval.'
                  : 'Source parent channel is not configured for automatic threading.',
                'Planned',
              ),
            )
          }
          case 'DocsQuery': {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({ query: Schema.String, refreshCorpus: Schema.Boolean }),
            )(payload)
            return options.docs
              .query({ surface: 'cli', query: input.query, refreshCorpus: input.refreshCorpus })
              .pipe(Effect.map((result) => success(renderDocsResult(result))))
          }
          case 'DocsStatus':
            return Effect.succeed(success('Documentation workflow is configured and readiness-admitted.'))
          case 'RuntimeHealth':
            return Ref.get(options.health).pipe(
              Effect.map((state) =>
                success(
                  `state=${state.state} ready=${isReady(state)} authority=${state.actionAuthority} journal=${state.journal} gateway=${state.gateway} rest=${state.restProbe} handlers=${state.handlersRegistered} docs=${state.docsReady}`,
                ),
              ),
            )
          case 'RuntimeStatus':
            return Ref.get(options.health).pipe(
              Effect.map((state) =>
                success(`environment=${options.config.environment} mode=${options.config._tag} state=${state.state}`),
              ),
            )
          case 'ConfigValidate': {
            const input = Schema.decodeUnknownSync(Schema.Struct({ file: Schema.optional(Schema.String) }))(payload)
            return (input.file === undefined ? Effect.succeed(options.config) : loadRuntimeConfig(input.file)).pipe(
              Effect.map((config) => success(`Valid version 1 ${config._tag} config for ${config.environment}.`)),
              Effect.mapError(() => new ControlApplicationFailure({ message: 'Runtime config validation failed' })),
            )
          }
          case 'EffectiveConfig':
            return Effect.succeed(success(JSON.stringify(summarizeConfig(options.config))))
          case 'AuthStatus':
            return Effect.succeed(
              success(
                `principal=${principal.id} provenance=${principal.provenance} read=${principal.canRead} write=${principal.canWrite}`,
              ),
            )
          case 'ApplicationCommandsDiff':
            return options.commands.diff(options.config.commandScope).pipe(
              Effect.map((diff) => commandDiffResult(diff, 'Success')),
              Effect.mapError(() => new ControlApplicationFailure({ message: 'Application-command diff failed' })),
            )
          case 'ApplicationCommandsSync': {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                environment: DeploymentEnvironment,
                apply: Schema.Literal(true),
                reason: OperatorReason,
              }),
            )(payload)
            if (input.environment !== options.config.environment) {
              return Effect.fail(
                new ControlApplicationFailure({ message: 'Requested environment does not match the running bot' }),
              )
            }
            return options.commands.sync(options.config.commandScope).pipe(
              Effect.map((result) =>
                commandDiffResult(result.after, result.changed === true ? 'Success' : 'AlreadySatisfied'),
              ),
              Effect.mapError(() => new ControlApplicationFailure({ message: 'Application-command sync failed' })),
            )
          }
          case 'StagingE2ERun':
            return unsupported(
              'Use the dedicated staging E2E harness; this runtime does not self-authorize live writes.',
            )
        }
      } catch {
        return Effect.fail(new ControlApplicationFailure({ message: 'Control request payload is invalid' }))
      }
    },
  }
}

export const serveBotControl = (path: string, handlers: ControlHandlers, policy: ControlSocketPolicy) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (policy.mode === 'fake') await mkdir(dirname(path), { recursive: true, mode: 0o750 })
        await removeStaleSocket(path)
        // One request is delimited by the client's write-side FIN; keep the
        // server write side open long enough to return the correlated response.
        const server = createServer({ allowHalfOpen: true }, (socket) => handleSocket(socket, path, policy, handlers))
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(path, resolve)
        })
        await chmod(path, 0o660)
        return server
      },
      catch: (cause) =>
        new ControlDependencyUnavailable({
          dependency: 'control-socket',
          message: cause instanceof Error ? cause.message : 'Control socket could not start',
        }),
    }),
    (server) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))).pipe(
        Effect.andThen(Effect.promise(() => unlink(path).catch(() => undefined))),
      ),
  ).pipe(Effect.withSpan('runtime.control.serve'))

/** A typed client facade over a one-request-per-connection versioned protocol. */
export const makeUnixBotControlClient = (path: string) =>
  Effect.gen(function* () {
    let writeResponse: ((message: FromServer<RpcGroup.Rpcs<typeof BotControl>>) => Effect.Effect<void>) | undefined
    const built = yield* RpcClient.makeNoSerialization(BotControl, {
      supportsAck: false,
      onFromClient: ({ message }) => {
        if (message._tag !== 'Request') return Effect.void
        return Effect.exit(sendRequest(path, message.tag, message.payload)).pipe(
          Effect.flatMap((exit) =>
            writeResponse === undefined
              ? Effect.die('Bot control client response channel was not initialized')
              : writeResponse({ _tag: 'Exit', clientId: 0, requestId: message.id, exit }),
          ),
        )
      },
    })
    writeResponse = built.write
    return built.client
  })

const sendRequest = (path: string, operation: BotControlOperation, payload: unknown) =>
  Effect.callback<ControlResultType, ControlErrorType>((resume) => {
    const id = crypto.randomUUID()
    const socket = createConnection(path)
    let data = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.end(`${JSON.stringify({ apiVersion: 1, id, operation, payload })}\n`))
    socket.on('data', (chunk) => {
      data += chunk
    })
    socket.once('error', () =>
      resume(
        Effect.fail(
          new ControlDependencyUnavailable({
            dependency: 'control-socket',
            message: 'Could not connect to bot control socket',
          }),
        ),
      ),
    )
    socket.once('end', () => {
      try {
        const response = decodeResponse(data.trim())
        if (response.id !== id) throw new Error('Response correlation mismatch')
        resume('result' in response ? Effect.succeed(response.result) : Effect.fail(response.error))
      } catch {
        resume(
          Effect.fail(
            new ControlDependencyUnavailable({
              dependency: 'control-socket',
              message: 'Bot control response was invalid',
            }),
          ),
        )
      }
    })
    return Effect.sync(() => socket.destroy())
  })

const handleSocket = (socket: Socket, path: string, policy: ControlSocketPolicy, handlers: ControlHandlers) => {
  let data = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    data += chunk
    if (Buffer.byteLength(data) > maximumRequestBytes) socket.destroy()
  })
  socket.once('end', () => {
    let request: typeof RequestEnvelope.Type
    try {
      request = decodeRequest(data.trim())
    } catch {
      socket.end()
      return
    }
    if (isOperation(request.operation) === false) {
      socket.end()
      return
    }
    const operation = request.operation
    Effect.runPromiseExit(
      resolveControlPrincipal(socket, path, policy).pipe(
        Effect.flatMap((principal) =>
          auditControlOperation(
            operation,
            request.payload,
            principal,
            handlers.invoke(operation, request.payload, principal),
          ),
        ),
      ),
    )
      .then((exit) => {
        const response =
          Exit.isSuccess(exit) === true
            ? { apiVersion: 1 as const, id: request.id, result: exit.value }
            : { apiVersion: 1 as const, id: request.id, error: extractControlError(exit) }
        socket.end(`${encodeResponse(response)}\n`)
      })
      .catch(() =>
        socket.end(
          `${encodeResponse({
            apiVersion: 1,
            id: request.id,
            error: new ControlApplicationFailure({ message: 'Control operation failed unexpectedly' }),
          })}\n`,
        ),
      )
  })
}

const extractControlError = (exit: Exit.Exit<unknown, ControlErrorType>): ControlErrorType => {
  if (Exit.isSuccess(exit) === true)
    return new ControlApplicationFailure({ message: 'Control operation unexpectedly succeeded without a result' })
  const error = Cause.findErrorOption(exit.cause)
  return Option.isSome(error) === true
    ? error.value
    : new ControlApplicationFailure({ message: 'Control operation failed unexpectedly' })
}

const operationNames = new Set<string>([
  'ThreadInspect',
  'ThreadPlan',
  'ThreadCreate',
  'ThreadStatus',
  'ThreadReconcile',
  'ThreadPolicyExplain',
  'DocsQuery',
  'DocsStatus',
  'RuntimeHealth',
  'RuntimeStatus',
  'ConfigValidate',
  'EffectiveConfig',
  'AuthStatus',
  'ApplicationCommandsDiff',
  'ApplicationCommandsSync',
  'StagingE2ERun',
])
const isOperation = (value: string): value is BotControlOperation => operationNames.has(value)

const isWriteOperation = (operation: BotControlOperation, payload: unknown): boolean => {
  if (operation === 'ThreadCreate' || operation === 'ApplicationCommandsSync' || operation === 'StagingE2ERun') {
    return true
  }
  return (
    operation === 'ThreadReconcile' &&
    typeof payload === 'object' &&
    payload !== null &&
    'apply' in payload &&
    payload.apply === true
  )
}

const auditControlOperation = (
  operation: BotControlOperation,
  payload: unknown,
  principal: ControlPrincipal,
  effect: Effect.Effect<ControlResultType, ControlErrorType>,
) => {
  if (isWriteOperation(operation, payload) === false) return effect
  const annotate = Effect.annotateLogs({
    controlOperation: operation,
    controlPrincipal: principal.id,
    principalProvenance: principal.provenance,
  })
  return effect.pipe(
    Effect.tap((result) =>
      Effect.logInfo('Control write completed').pipe(Effect.annotateLogs({ controlOutcome: result._tag }), annotate),
    ),
    Effect.tapError((error) =>
      Effect.logWarning('Control write rejected or failed').pipe(
        Effect.annotateLogs({ controlOutcome: error._tag }),
        annotate,
      ),
    ),
  )
}

const decodeSource = Schema.decodeUnknownSync(Schema.Struct({ source: DiscordMessageRef }))

const controlResultFromThreadOutcome = (outcome: ThreadOutcome): Effect.Effect<ControlResultType, ControlErrorType> => {
  switch (outcome._tag) {
    case 'Created':
      return Effect.succeed(success(`Created thread ${outcome.threadId}.`, 'Success', outcome.source.messageId))
    case 'AlreadySatisfied':
      return Effect.succeed(
        success(
          `Thread ${outcome.threadId} already satisfies the request.`,
          'AlreadySatisfied',
          outcome.source.messageId,
        ),
      )
    case 'AuthorizationRejected':
      return Effect.fail(new ControlApplicationFailure({ message: 'Thread request was not authorized' }))
    case 'PolicyRejected':
      return Effect.fail(
        new ControlApplicationFailure({ message: `Thread request rejected by policy: ${outcome.reason}` }),
      )
    case 'TerminalFailure':
      return Effect.fail(new ControlApplicationFailure({ message: `Thread creation failed: ${outcome.failureCode}` }))
    case 'TransientFailure':
      return Effect.fail(
        new ControlAmbiguousOutcome({
          message: `Thread outcome requires reconciliation: ${outcome.failureCode}`,
          correlationId: outcome.source.messageId,
        }),
      )
  }
}

const success = (
  summary: string,
  tag: ControlResultType['_tag'] = 'Success',
  correlationId?: string,
): ControlResultType => ({ _tag: tag, summary, correlationId })

const renderReconciliationResult =
  (applied: boolean) =>
  (result: ReconciliationResult): ControlResultType => {
    const unrun = result.receipts.filter((receipt) => receipt.disposition === 'unrun').length
    const mutated = result.receipts.filter((receipt) => receipt.mutated).length
    return {
      _tag: unrun > 0 ? 'Unrun' : applied === true ? 'Success' : 'Planned',
      summary: `receipts=${result.receipts.length} mutated=${mutated} unrun=${unrun} truncated=${result.truncated}`,
      receiptId: result.receipts.length === 1 ? result.receipts[0]?.receiptId : undefined,
    }
  }

const commandDiffResult = (
  diff: {
    readonly changes: ReadonlyArray<{ readonly kind: 'create' | 'update' | 'delete' | 'unchanged' }>
    readonly hasChanges: boolean
  },
  tag: ControlResultType['_tag'],
): ControlResultType => {
  const counts = { create: 0, update: 0, delete: 0, unchanged: 0 }
  for (const change of diff.changes) counts[change.kind] += 1
  return {
    _tag: tag,
    summary: `changes=${diff.hasChanges} create=${counts.create} update=${counts.update} delete=${counts.delete} unchanged=${counts.unchanged}`,
  }
}

interface FileIdentity {
  readonly uid: number
  readonly gid: number
  readonly mode: number
  readonly isDirectory: boolean
  readonly isSocket: boolean
}

/**
 * Node currently has no portable SO_PEERCRED API. The fallback admits writes
 * only when a root-owned, setgid environment directory and its socket prove
 * one closed group boundary. The numeric group is the principal because RPC
 * input is never allowed to assert a user identity.
 */
export const classifyFilesystemControlPolicy = (input: {
  readonly path: string
  readonly environment: ControlSocketPolicy['environment']
  readonly directory: FileIdentity
  readonly socket: FileIdentity
  readonly runtimeUid?: number
}): ControlPrincipal | undefined => {
  const expectedPath = `/run/discord-bot/${input.environment}/control.sock`
  const directoryMode = input.directory.mode & 0o7777
  const socketMode = input.socket.mode & 0o777
  const socketOwnerIsRuntime = input.runtimeUid !== undefined && input.socket.uid === input.runtimeUid
  if (
    input.path !== expectedPath ||
    input.directory.isDirectory === false ||
    input.directory.uid !== 0 ||
    (directoryMode & 0o2000) === 0 ||
    (directoryMode & 0o007) !== 0 ||
    input.socket.isSocket === false ||
    input.socket.gid !== input.directory.gid ||
    (socketOwnerIsRuntime === false && input.socket.uid !== 0) ||
    socketMode !== 0o660
  )
    return undefined
  return {
    id: `unix-group:gid=${input.directory.gid}:environment=${input.environment}`,
    provenance: 'filesystem-policy',
    canRead: true,
    canWrite: true,
  }
}

const resolveControlPrincipal = (
  socket: Socket,
  path: string,
  policy: ControlSocketPolicy,
): Effect.Effect<ControlPrincipal> => {
  if (policy.mode === 'fake') {
    return Effect.succeed({
      id: `fake-runtime:${policy.environment}`,
      provenance: 'fake-runtime',
      canRead: true,
      canWrite: true,
    })
  }
  return Effect.tryPromise({
    try: async () => {
      const [directory, socketInfo] = await Promise.all([lstat(dirname(path)), lstat(path)])
      const filesystemPrincipal = classifyFilesystemControlPolicy({
        path,
        environment: policy.environment,
        directory: fileIdentity(directory),
        socket: fileIdentity(socketInfo),
        ...(process.getuid?.() === undefined ? {} : { runtimeUid: process.getuid() }),
      })
      if (filesystemPrincipal === undefined) return unverifiedPrincipal(policy.environment)
      const credentials = readPeerCredentials(socket)
      return credentials === undefined
        ? filesystemPrincipal
        : classifyPeerControlPrincipal({
            filesystemPrincipal,
            operatorGid: Number(directory.gid),
            credentials,
            ...(process.getuid?.() === undefined ? {} : { runtimeUid: process.getuid() }),
            environment: policy.environment,
          })
    },
    catch: (cause) =>
      new ControlSocketInspectionError({
        message: cause instanceof Error ? cause.message : 'Control socket inspection failed',
      }),
  }).pipe(Effect.catchCause(() => Effect.succeed(unverifiedPrincipal(policy.environment))))
}

export const classifyPeerControlPrincipal = (input: {
  readonly filesystemPrincipal: ControlPrincipal
  readonly operatorGid: number
  readonly credentials: { readonly uid: number; readonly gid: number; readonly pid: number }
  readonly runtimeUid?: number
  readonly environment: ControlSocketPolicy['environment']
}): ControlPrincipal => {
  if (
    input.filesystemPrincipal.canRead === false ||
    input.filesystemPrincipal.canWrite === false ||
    input.credentials.gid !== input.operatorGid
  ) {
    return unverifiedPrincipal(input.environment)
  }
  return {
    id: `unix-peer:uid=${input.credentials.uid}:gid=${input.credentials.gid}:pid=${input.credentials.pid}`,
    provenance: 'peer-credentials',
    canRead: true,
    // The service identity owns runtime internals; it is not an operator even
    // when its primary group is also the socket's operator group.
    canWrite: input.runtimeUid === undefined || input.credentials.uid !== input.runtimeUid,
  }
}

const unverifiedPrincipal = (environment: ControlSocketPolicy['environment']): ControlPrincipal => ({
  id: `unverified-unix-peer:environment=${environment}`,
  provenance: 'filesystem-policy',
  canRead: false,
  canWrite: false,
})

const readPeerCredentials = (
  socket: Socket,
): { readonly uid: number; readonly gid: number; readonly pid: number } | undefined => {
  const method = Reflect.get(socket, 'getPeerCredentials')
  if (typeof method !== 'function') return undefined
  try {
    const value: unknown = Reflect.apply(method, socket, [])
    if (typeof value !== 'object' || value === null) return undefined
    if (!('uid' in value) || typeof value.uid !== 'number') return undefined
    if (!('gid' in value) || typeof value.gid !== 'number') return undefined
    if (!('pid' in value) || typeof value.pid !== 'number') return undefined
    return { uid: value.uid, gid: value.gid, pid: value.pid }
  } catch {
    return undefined
  }
}

const fileIdentity = (info: Awaited<ReturnType<typeof lstat>>): FileIdentity => ({
  uid: Number(info.uid),
  gid: Number(info.gid),
  mode: Number(info.mode),
  isDirectory: info.isDirectory(),
  isSocket: info.isSocket(),
})

const removeStaleSocket = async (path: string) => {
  try {
    const info = await lstat(path)
    if (info.isSocket() === false) throw new Error('Control socket path exists and is not a socket')
    if ((await socketAcceptsConnections(path)) === true)
      throw new Error('Control socket is already owned by a live process')
    await unlink(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

const socketAcceptsConnections = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
