import { execFile } from 'node:child_process'

import { NodeHttpClient } from '@effect/platform-node'
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import { discordSafeLoggerLayer, redactDiscordRestCause } from '../../src/discord/rest-error-redaction.ts'
import type { MessageSnapshot, ResponseSnapshot, Snowflake } from './model.ts'
import { E2EPrerequisiteUnavailableError } from './transport.ts'

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (executable: string, args: ReadonlyArray<string>) => Promise<CommandResult>

export const defaultRunCommand: CommandRunner = (executable, args) =>
  new Promise((resolve) => {
    execFile(executable, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr,
      })
    })
  })

/** How a broker gesture was physically performed; recorded so receipts never overclaim. */
export type GesturePerformer = 'human' | 'official-client-session'

export interface BrokerLedgerInput {
  readonly kind: 'message' | 'thread' | 'response'
  readonly guildId: string
  readonly channelId: string
  readonly messageId: string
}

export interface BrokerMessageIntent {
  readonly guildId: string
  readonly channelId: string
  readonly marker: string
}

export interface BrokerLedger {
  readonly record: (entry: BrokerLedgerInput) => void
  readonly resolve: (entry: BrokerLedgerInput) => void
  readonly recordMessageIntent: (entry: BrokerMessageIntent) => void
  readonly resolveMessageIntent: (entry: BrokerMessageIntent) => void
  readonly close: () => void
}

export interface AttendedBrokerDeps {
  readonly driver: AttendedBrokerDriver
  readonly correlator: BrokerCorrelator
  readonly performer: GesturePerformer
  readonly openLedger: (input: { readonly filePath: string; readonly runId: string }) => BrokerLedger
}

export const brokerOperations = [
  'create-message',
  'invoke-message-action',
  'invoke-docs',
  'resolve-message',
  'resolve-response',
  'resolve-thread',
] as const

export type BrokerOperation = (typeof brokerOperations)[number]

export interface ParsedBrokerInvocation {
  readonly operation: BrokerOperation
  readonly request: unknown
  readonly ledgerPath: string | undefined
  /** Runner-scoped identity; required with --ledger so record/resolve match. */
  readonly runId: string | undefined
}

export type ParseBrokerResult =
  | { readonly _tag: 'Parsed'; readonly value: ParsedBrokerInvocation }
  | { readonly _tag: 'UsageError'; readonly message: string }

/** Browser-observed replies may be ephemeral and have no REST-visible message ID. */
export interface GestureEvidence {
  readonly declined?: true
  readonly messageActionOutcome?: 'created' | 'denied'
  readonly docsOutcome?: 'answered' | 'denied'
  /** ID-backed responses (when available) are journaled and deleted by the actor. */
  readonly responseMessageIds?: ReadonlyArray<string>
  /** UI-observed ephemeral replies cannot be deleted by the actor. */
  readonly ephemeralResponseCount?: number
  /** Count of public docs rows; exact deletable IDs come from the actor REST seam. */
  readonly publicResponseCount?: number
}

export interface AttendedBrokerDriver {
  readonly perform: (input: {
    readonly operation: BrokerOperation
    readonly request: unknown
  }) => Promise<GestureEvidence>
}

/**
 * Correlated Discord facts the broker waits for through the actor-bot REST
 * seam after the driver reports the gesture was performed.
 */
export interface CorrelationFacts {
  readonly message: MessageSnapshot | undefined
  readonly threadCreated: boolean
}

export interface BrokerCorrelator {
  readonly waitForMessage: (input: {
    readonly channelId: Snowflake
    readonly marker: string
    readonly timeoutMs: number
    readonly pollIntervalMs: number
  }) => Promise<MessageSnapshot>
  readonly waitForThread: (input: {
    readonly guildId: Snowflake
    readonly sourceMessageId: Snowflake
    readonly timeoutMs: number
    readonly pollIntervalMs: number
  }) => Promise<Snowflake | undefined>
  readonly snapshotPublicResponseIds: (channelId: Snowflake) => Promise<ReadonlyArray<Snowflake>>
  readonly waitForPublicResponses: (input: {
    readonly channelId: Snowflake
    readonly beforeIds: ReadonlyArray<Snowflake>
    readonly expectedCount: number
    readonly timeoutMs: number
    readonly pollIntervalMs: number
  }) => Promise<ReadonlyArray<Snowflake>>
  readonly dispose: () => Promise<void>
}

const asSnowflake = (value: string, label: string): Snowflake => {
  if (/^\d{17,20}$/u.test(value) === false) throw new Error(`broker ${label} returned an invalid snowflake`)
  return value as Snowflake
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const parseBrokerInvocation = (args: ReadonlyArray<string>): ParseBrokerResult => {
  const usage =
    'Usage: livestore-discord-e2e-broker <create-message|invoke-message-action|invoke-docs|resolve-message|resolve-response|resolve-thread> --request-json JSON [--ledger FILE]'
  const flagValueIndices: number[] = []
  args.forEach((value, index) => {
    if (value === '--request-json' || value === '--ledger' || value === '--run-id')
      flagValueIndices.push(index, index + 1)
  })
  const positional = args.flatMap((value, index) => (flagValueIndices.includes(index) === false ? [value] : []))
  const [operation, ...extra] = positional
  if (
    operation === undefined ||
    extra.length !== 0 ||
    brokerOperations.includes(operation as BrokerOperation) === false
  ) {
    return { _tag: 'UsageError', message: usage }
  }
  const jsonFlags = args.flatMap((value, index) => (value === '--request-json' ? [index] : []))
  if (jsonFlags.length !== 1) return { _tag: 'UsageError', message: usage }
  const raw = args[jsonFlags[0]! + 1]
  if (raw === undefined) return { _tag: 'UsageError', message: usage }
  let request: unknown
  try {
    request = JSON.parse(raw)
  } catch {
    return { _tag: 'UsageError', message: usage }
  }
  const ledgerFlags = args.flatMap((value, index) => (value === '--ledger' ? [index] : []))
  if (ledgerFlags.length > 1) return { _tag: 'UsageError', message: usage }
  const ledgerPath = ledgerFlags.length === 1 ? args[ledgerFlags[0]! + 1] : undefined
  if (ledgerFlags.length === 1 && ledgerPath === undefined) return { _tag: 'UsageError', message: usage }
  const runIdFlags = args.flatMap((value, index) => (value === '--run-id' ? [index] : []))
  if (runIdFlags.length > 1) return { _tag: 'UsageError', message: usage }
  const runId = runIdFlags.length === 1 ? args[runIdFlags[0]! + 1] : undefined
  if ((runIdFlags.length === 1 || ledgerFlags.length === 1) && (runId === undefined || ledgerPath === undefined)) {
    return { _tag: 'UsageError', message: usage }
  }
  return { _tag: 'Parsed', value: { operation: operation as BrokerOperation, request, ledgerPath, runId } }
}

/** Correlation windows ride on the injected target context; sane defaults otherwise. */
const readTiming = (
  request: Record<string, unknown>,
): { readonly timeoutMs: number; readonly pollIntervalMs: number } => ({
  timeoutMs: typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? request.timeoutMs : 30_000,
  pollIntervalMs:
    typeof request.pollIntervalMs === 'number' && request.pollIntervalMs > 0 ? request.pollIntervalMs : 1_000,
})

const readRequestString = (request: Record<string, unknown>, key: string, label: string): string => {
  const value = request[key]
  if (typeof value !== 'string' || value === '') throw new Error(`broker ${label} request is missing ${key}`)
  return value
}

/** A broker subprocess receives the configured staging application via its request, not package layout. */
export const readBrokerApplicationId = (request: unknown): Snowflake => {
  if (typeof request !== 'object' || request === null || Array.isArray(request) === true)
    throw new Error('broker request must be a JSON object')
  if ('applicationId' in request === false || typeof request.applicationId !== 'string')
    throw new Error('broker request is missing applicationId')
  return asSnowflake(request.applicationId, 'application ID')
}

/** DFX-backed correlator: the actor bot observes the staging application's replies. */
export const makeDfxBrokerCorrelator = (input: {
  readonly actorBotToken: string
  readonly targetApplicationId: string
}): BrokerCorrelator => {
  const DiscordLive = DiscordRESTMemoryLive.pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(DiscordConfig.layer({ token: Redacted.make(input.actorBotToken) })),
  )
  const runtime = ManagedRuntime.make(Layer.merge(DiscordLive, discordSafeLoggerLayer))
  const rest = <A, E>(effect: Effect.Effect<A, E, DiscordREST>): Promise<A> =>
    runtime.runPromise(effect.pipe(Effect.catchCause((cause) => Effect.fail(redactDiscordRestCause(cause)))))
  const listPublicResponses = async (channelId: Snowflake): Promise<ReadonlyArray<Snowflake>> => {
    const messages: unknown = await rest(
      Effect.flatMap(DiscordREST, (discord) => discord.listMessages(channelId, { limit: 100 })),
    )
    if (Array.isArray(messages) === false) throw new Error('Public response listing was invalid')
    return messages.flatMap((item): ReadonlyArray<Snowflake> => {
      if (
        typeof item !== 'object' ||
        item === null ||
        !('id' in item) ||
        typeof item.id !== 'string' ||
        !('application_id' in item) ||
        item.application_id !== input.targetApplicationId
      )
        return []
      return [asSnowflake(item.id, 'public docs response')]
    })
  }

  return {
    waitForMessage: async ({ channelId, marker, timeoutMs, pollIntervalMs }) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const channelMessages: unknown = await rest(
          Effect.flatMap(DiscordREST, (discord) => discord.listMessages(channelId, { limit: 50 })),
        )
        const candidates = Array.isArray(channelMessages) === true ? channelMessages : []
        const candidate = candidates.find(
          (message): message is { id: string; channel_id: string; content: string; author?: { bot?: boolean } } =>
            typeof message === 'object' &&
            message !== null &&
            'id' in message &&
            typeof (message as { content?: unknown }).content === 'string' &&
            (message as { content: string }).content.includes(marker),
        )
        if (candidate !== undefined && candidate.author?.bot !== true) {
          return {
            id: asSnowflake(candidate.id, 'wait-for-message'),
            channelId: asSnowflake(candidate.channel_id, 'wait-for-message'),
            marker,
            author: 'human',
          }
        }
        await sleep(pollIntervalMs)
      }
      throw new E2EPrerequisiteUnavailableError('Official-client message did not appear before the deadline')
    },
    waitForThread: async ({ guildId, sourceMessageId, timeoutMs, pollIntervalMs }) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const active = await rest(Effect.flatMap(DiscordREST, (discord) => discord.getActiveGuildThreads(guildId)))
        const candidate = active.threads.find((thread) => thread.id === sourceMessageId)
        if (candidate !== undefined) return asSnowflake(candidate.id, 'wait-for-thread')
        await sleep(pollIntervalMs)
      }
      return undefined
    },
    snapshotPublicResponseIds: listPublicResponses,
    waitForPublicResponses: async ({ channelId, beforeIds, expectedCount, timeoutMs, pollIntervalMs }) => {
      const before = new Set(beforeIds)
      const deadline = Date.now() + timeoutMs
      let lastCount = 0
      while (Date.now() < deadline) {
        const found = (await listPublicResponses(channelId)).filter((id) => before.has(id) === false)
        if (found.length >= expectedCount && found.length === lastCount) return found.toReversed()
        lastCount = found.length
        await sleep(pollIntervalMs)
      }
      throw new E2EPrerequisiteUnavailableError('Public docs replies did not correlate before the deadline')
    },
    dispose: () => runtime.dispose(),
  }
}

export interface BrokerDispatchResult {
  readonly payload: Record<string, unknown>
  readonly declineExitCode: undefined | 7
}

/** Executes one broker operation end to end: gesture, correlation, ledger, attested result. */
export const dispatchBrokerOperation = async (
  invocation: ParsedBrokerInvocation,
  deps: AttendedBrokerDeps,
): Promise<BrokerDispatchResult> => {
  if (
    typeof invocation.request !== 'object' ||
    invocation.request === null ||
    Array.isArray(invocation.request) === true
  ) {
    throw new Error('broker request must be a JSON object')
  }
  const request = invocation.request as Record<string, unknown>

  // Open the ledger before any gesture; a pre-send intent survives crashes and
  // correlation timeouts even when the client already submitted the message.
  const context = {
    guildId: asSnowflake(readRequestString(request, 'guildId', 'broker'), 'broker'),
    channelId: asSnowflake(readRequestString(request, 'channelId', 'broker'), 'broker'),
  }
  const ledger =
    invocation.ledgerPath === undefined || invocation.runId === undefined
      ? undefined
      : deps.openLedger({ filePath: invocation.ledgerPath, runId: invocation.runId })
  try {
    if (invocation.operation === 'create-message') {
      const marker = readRequestString(request, 'marker', 'create-message')
      if (readRequestString(request, 'content', 'create-message').includes(marker) === false)
        throw new Error('create-message content must contain its correlation marker')
      ledger?.recordMessageIntent({ ...context, marker })
    }
    const publicResponseIdsBefore =
      invocation.operation === 'invoke-docs' ? await deps.correlator.snapshotPublicResponseIds(context.channelId) : []
    const evidence =
      invocation.operation === 'resolve-thread' ||
      invocation.operation === 'resolve-message' ||
      invocation.operation === 'resolve-response'
        ? {}
        : await deps.driver.perform({ operation: invocation.operation, request })
    if (evidence.declined === true) {
      if (invocation.operation === 'create-message')
        ledger?.resolveMessageIntent({ ...context, marker: readRequestString(request, 'marker', 'create-message') })
      return {
        payload: { declinedByOperator: true, error: { reason: 'operator-declined' } },
        declineExitCode: 7,
      }
    }
    return await dispatchWithLedger(invocation, deps, evidence, context, ledger, publicResponseIdsBefore)
  } finally {
    ledger?.close()
  }
}
const dispatchWithLedger = async (
  invocation: ParsedBrokerInvocation,
  deps: AttendedBrokerDeps,
  evidence: GestureEvidence,
  context: { readonly guildId: Snowflake; readonly channelId: Snowflake },
  ledger: BrokerLedger | undefined,
  publicResponseIdsBefore: ReadonlyArray<Snowflake>,
): Promise<BrokerDispatchResult> => {
  const request = invocation.request as Record<string, unknown>
  const record = (kind: BrokerLedgerInput['kind'], messageId: string): void => {
    // Write-before-acknowledge: the exact artifact exists in the durable ledger
    // before the runner learns about it, so a later crash cannot orphan it.
    ledger?.record({ kind, guildId: context.guildId, channelId: context.channelId, messageId })
  }

  if (invocation.operation === 'create-message') {
    const marker = readRequestString(invocation.request as Record<string, unknown>, 'marker', 'create-message')
    const message = await deps.correlator.waitForMessage({
      channelId: context.channelId,
      marker,
      timeoutMs: 30_000,
      pollIntervalMs: readTiming(request).pollIntervalMs,
    })
    if (message.channelId !== context.channelId || message.marker !== marker || message.author !== 'human')
      throw new Error('Correlated message did not match requested channel, marker, and human author')
    record('message', message.id)
    ledger?.resolveMessageIntent({ ...context, marker })
    return { payload: { ...message, performedBy: deps.performer }, declineExitCode: undefined }
  }

  if (invocation.operation === 'invoke-message-action') {
    const outcome = evidence.messageActionOutcome
    if (outcome === undefined) throw new Error('driver returned no message action outcome')
    const sourceMessageId = asSnowflake(
      readRequestString(invocation.request as Record<string, unknown>, 'sourceMessageId', 'message action'),
      'message action',
    )
    const responseIds = (evidence.responseMessageIds ?? []).map((id) => asSnowflake(id, 'message action'))
    const ephemeralCount = evidence.ephemeralResponseCount ?? 0
    if (responseIds.length + ephemeralCount === 0) throw new Error('message action evidence carried no response')
    if (outcome === 'created') {
      const threadId = await deps.correlator.waitForThread({
        guildId: context.guildId,
        sourceMessageId,
        ...readTiming(request),
      })
      if (threadId === undefined) throw new Error('client reported creation but no correlated thread appeared')
      record('thread', threadId)
      for (const id of responseIds) record('response', id)
      return {
        payload: {
          _tag: 'Created',
          thread: {
            id: threadId,
            guildId: context.guildId,
            parentChannelId: context.channelId,
            sourceMessageId,
            // The runner's ownership check compares this against its own marker.
            marker: readRequestString(invocation.request as Record<string, unknown>, 'marker', 'message action'),
          },
          response: responseSnapshot(responseIds[0], invocation.request as Record<string, unknown>, {
            hasAnswer: false,
            hasSources: false,
          }),
          performedBy: deps.performer,
        },
        declineExitCode: undefined,
      }
    }
    for (const id of responseIds) record('response', id)
    return {
      payload: {
        _tag: 'Denied',
        response: responseSnapshot(responseIds[0], invocation.request as Record<string, unknown>, {
          hasAnswer: false,
          hasSources: false,
        }),
        performedBy: deps.performer,
      },
      declineExitCode: undefined,
    }
  }

  if (invocation.operation === 'invoke-docs') {
    const outcome = evidence.docsOutcome
    if (outcome === undefined) throw new Error('driver returned no docs outcome')
    const publicCount = evidence.publicResponseCount ?? 0
    const publicIds =
      publicCount > 0
        ? await deps.correlator.waitForPublicResponses({
            channelId: context.channelId,
            beforeIds: publicResponseIdsBefore,
            expectedCount: publicCount,
            ...readTiming(request),
          })
        : []
    const responseIds = [...(evidence.responseMessageIds ?? []).map((id) => asSnowflake(id, 'docs')), ...publicIds]
    const ephemeralCount = evidence.ephemeralResponseCount ?? 0
    if (responseIds.length + ephemeralCount === 0) throw new Error('docs evidence carried no responses')
    for (const id of responseIds) record('response', id)
    const answered = outcome === 'answered'
    const ids: ReadonlyArray<Snowflake | undefined> = [
      ...responseIds,
      ...Array.from({ length: ephemeralCount }, () => undefined),
    ]
    const responses: ReadonlyArray<ResponseSnapshot> = ids.map((id) =>
      responseSnapshot(id, invocation.request as Record<string, unknown>, {
        hasAnswer: answered,
        hasSources: answered,
      }),
    )
    return {
      payload: {
        _tag: outcome === 'answered' ? 'Answered' : 'Denied',
        responses,
        performedBy: deps.performer,
      },
      declineExitCode: undefined,
    }
  }

  const expectedId = asSnowflake(readRequestString(request, 'id', 'cleanup'), 'cleanup')
  if (ledger === undefined) throw new Error('artifact resolution requires a cleanup ledger')
  const kind =
    invocation.operation === 'resolve-thread'
      ? 'thread'
      : invocation.operation === 'resolve-response'
        ? 'response'
        : 'message'
  ledger.resolve({ kind, ...context, messageId: expectedId })
  return { payload: { resolved: true, id: expectedId }, declineExitCode: undefined }
}

const responseSnapshot = (
  id: Snowflake | undefined,
  request: Record<string, unknown>,
  flags: { readonly hasAnswer: boolean; readonly hasSources: boolean },
): ResponseSnapshot => ({
  ...(id === undefined ? { ephemeral: true as const } : { id }),
  channelId: asSnowflake(readRequestString(request, 'channelId', 'response'), 'response'),
  marker: readRequestString(request, 'marker', 'response'),
  hasAnswer: flags.hasAnswer,
  hasSources: flags.hasSources,
})
