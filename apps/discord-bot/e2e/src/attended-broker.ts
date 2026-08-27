import { execFile } from 'node:child_process'

import { NodeHttpClient } from '@effect/platform-node'
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

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

export interface BrokerLedger {
  readonly record: (entry: BrokerLedgerInput) => void
  readonly resolve: (entry: BrokerLedgerInput) => void
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
  'delete-message',
  'delete-response',
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

/**
 * Evidence a driver extracted from the official client after performing one
 * gesture. Ephemeral interaction responses are invisible to bot REST reads, so
 * their exact IDs may only come from the client session itself.
 */
export interface GestureEvidence {
  /** The driver observed the human/operator decline or abort the gesture. */
  readonly declined?: true
  readonly messageActionOutcome?: 'created' | 'denied'
  readonly docsOutcome?: 'answered' | 'denied'
  /** Exact message IDs of interaction responses read from the client UI. */
  readonly responseMessageIds?: ReadonlyArray<string>
}

export interface AttendedBrokerDriver {
  readonly perform: (input: { readonly operation: BrokerOperation; readonly request: unknown }) => Promise<GestureEvidence>
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
  readonly dispose: () => Promise<void>
}


const asSnowflake = (value: string, label: string): Snowflake => {
  if (/^\d{17,20}$/u.test(value) === false) throw new Error(`broker ${label} returned an invalid snowflake`)
  return value as Snowflake
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const parseBrokerInvocation = (args: ReadonlyArray<string>): ParseBrokerResult => {
  const usage =
    'Usage: livestore-discord-e2e-broker <create-message|invoke-message-action|invoke-docs|delete-message|delete-response|resolve-thread> --request-json JSON [--ledger FILE]'
  const flagValueIndices: number[] = []
  args.forEach((value, index) => {
    if (value === '--request-json' || value === '--ledger' || value === '--run-id') flagValueIndices.push(index, index + 1)
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
const readTiming = (request: Record<string, unknown>): { readonly timeoutMs: number; readonly pollIntervalMs: number } => ({
  timeoutMs: typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? request.timeoutMs : 30_000,
  pollIntervalMs: typeof request.pollIntervalMs === 'number' && request.pollIntervalMs > 0 ? request.pollIntervalMs : 1_000,
})

const readRequestString = (request: Record<string, unknown>, key: string, label: string): string => {
  const value = request[key]
  if (typeof value !== 'string' || value === '') throw new Error(`broker ${label} request is missing ${key}`)
  return value
}

/** DFX-backed correlator: polls the actor-bot REST seam until the gesture's effect appears. */
export const makeDfxBrokerCorrelator = (input: {
  readonly actorBotToken: string
}): BrokerCorrelator => {
  const DiscordLive = DiscordRESTMemoryLive.pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(DiscordConfig.layer({ token: Redacted.make(input.actorBotToken) })),
  )
  const runtime = ManagedRuntime.make(DiscordLive)
  const rest = <A, E>(effect: Effect.Effect<A, E, DiscordREST>): Promise<A> => runtime.runPromise(effect)

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
  if (typeof invocation.request !== 'object' || invocation.request === null || Array.isArray(invocation.request) === true) {
    throw new Error('broker request must be a JSON object')
  }
  const request = invocation.request as Record<string, unknown>

  // resolve-thread acknowledges a deletion already completed through the bot
  // REST seam; it is ledger bookkeeping, not another official-client gesture.
  const evidence =
    invocation.operation === 'resolve-thread' ? {} : await deps.driver.perform({ operation: invocation.operation, request })
  if (evidence.declined === true) {
    return { payload: { declinedByOperator: true }, declineExitCode: 7 }
  }

  // Every request carries the staging target context appended by the runner.
  const context = {
    guildId: asSnowflake(readRequestString(request, 'guildId', 'broker'), 'broker'),
    channelId: asSnowflake(readRequestString(request, 'channelId', 'broker'), 'broker'),
  }
  const ledger =
    invocation.ledgerPath === undefined || invocation.runId === undefined
      ? undefined
      : deps.openLedger({ filePath: invocation.ledgerPath, runId: invocation.runId })

  try {
    return await dispatchWithLedger(invocation, deps, evidence, context, ledger)
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
    record('message', message.id)
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
    if (outcome === 'created') {
      const threadId = await deps.correlator.waitForThread({
        guildId: context.guildId,
        sourceMessageId,
        ...readTiming(request),
      })
      if (threadId === undefined) throw new Error('client reported creation but no correlated thread appeared')
      if (responseIds.length === 0) throw new Error('creation evidence carried no response artifact id')
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
          response: responseSnapshot(responseIds[0] as Snowflake, invocation.request as Record<string, unknown>, {
            hasAnswer: false,
            hasSources: false,
          }),
          performedBy: deps.performer,
        },
        declineExitCode: undefined,
      }
    }
    if (responseIds.length === 0) throw new Error('denial evidence carried no response artifact id')
    for (const id of responseIds) record('response', id)
    return {
      payload: {
        _tag: 'Denied',
        response: responseSnapshot(responseIds[0] as Snowflake, invocation.request as Record<string, unknown>, {
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
    const responseIds = (evidence.responseMessageIds ?? []).map((id) => asSnowflake(id, 'docs'))
    if (responseIds.length === 0) throw new Error('docs evidence carried no response artifact ids')
    for (const id of responseIds) record('response', id)
    const answered = outcome === 'answered'
    const responses: ReadonlyArray<ResponseSnapshot> = responseIds.map((id, index) =>
      responseSnapshot(id, invocation.request as Record<string, unknown>, {
        // Only the first chunked reply carries the answer and citation footer.
        hasAnswer: answered && index === 0,
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

  const expectedId = asSnowflake(
    typeof request.id === 'string' ? request.id : readRequestString(request, 'messageId', 'cleanup'),
    'cleanup',
  )
  if (invocation.operation === 'resolve-thread') {
    if (ledger === undefined) throw new Error('resolve-thread requires a cleanup ledger')
    ledger.resolve({ kind: 'thread', ...context, messageId: expectedId })
    return { payload: { resolved: true, id: expectedId }, declineExitCode: undefined }
  }

  // Client-confirmed response/source deletion resolves the exact identity that
  // creation recorded, including the original guild and channel.
  ledger?.resolve({
    kind: invocation.operation === 'delete-response' ? 'response' : 'message',
    ...context,
    messageId: expectedId,
  })
  return { payload: { deleted: true, id: expectedId, performedBy: deps.performer }, declineExitCode: undefined }
}

const responseSnapshot = (
  id: Snowflake,
  request: Record<string, unknown>,
  flags: { readonly hasAnswer: boolean; readonly hasSources: boolean },
): ResponseSnapshot => ({
  id,
  channelId: asSnowflake(readRequestString(request, 'channelId', 'response'), 'response'),
  marker: readRequestString(request, 'marker', 'response'),
  hasAnswer: flags.hasAnswer,
  hasSources: flags.hasSources,
})
