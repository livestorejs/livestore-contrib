import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CommandRunner } from './dfx-live-transport.ts'
import type { MessageSnapshot, ResponseSnapshot, Snowflake, ThreadSnapshot } from './model.ts'
import { E2EPrerequisiteUnavailableError, type DocsResult, type InteractionResult } from './transport.ts'
/** Only broker-authored, allowlisted diagnostics cross into a public receipt. */
export class BrokerOperationFailure extends Error {
  readonly reason: string
  readonly exitCode: number
  readonly status: number | undefined
  readonly discordCode: number | undefined
  readonly step: number | undefined

  constructor(reason: string, exitCode: number, status?: number, discordCode?: number, step?: number) {
    super(`Human handoff broker ${reason} (exit ${exitCode})`)
    this.reason = reason
    this.exitCode = exitCode
    this.status = status
    this.discordCode = discordCode
    this.step = step
  }
}

export interface HumanHandoffBroker {
  readonly createMessage: (input: {
    readonly channelId: Snowflake
    readonly marker: string
    readonly content: string
  }) => Promise<MessageSnapshot>
  readonly invokeMessageAction: (input: {
    readonly sourceMessageId: Snowflake
    readonly marker: string
    readonly persona: 'maintainer' | 'member'
  }) => Promise<InteractionResult>
  readonly invokeDocs: (input: {
    readonly channelId: Snowflake
    readonly marker: string
    readonly query: string
    readonly location: 'public' | 'restricted'
    readonly persona: 'maintainer' | 'contributor' | 'member'
  }) => Promise<DocsResult>
  /** Records actor-confirmed cleanup in the broker crash ledger. */
  readonly resolveMessage: (message: MessageSnapshot) => Promise<void>
  readonly resolveResponse: (response: ResponseSnapshot) => Promise<void>
  readonly resolveThread: (thread: ThreadSnapshot) => Promise<void>
}

/**
 * Delegates Discord user-only gestures to an explicitly configured, attended
 * broker. The broker may pause for a human; it must never log in as a user bot.
 */
export const makeCommandHumanHandoffBroker = (input: {
  readonly executable: string
  readonly runCommand: CommandRunner
  /** Staging target context appended to every payload so the broker can correlate. */
  readonly context?: { readonly guildId: string; readonly channelId: string; readonly applicationId: string }
  /** Durable ledger override; defaults to a private temp file per broker run. */
  readonly ledgerPath?: string
}): HumanHandoffBroker => {
  // Payload IDs are lane-specific (e.g. restricted docs channel); the target
  // context only fills fields some operations omit entirely.
  const withContext = (payload: object): object => ({ ...input.context, ...payload })
  // One run-scoped identity and ledger path for every invocation of this
  // broker: per-process ids would make record/resolve pairs unmatchable.
  const runId = randomUUID()
  const ledgerPath = input.ledgerPath ?? join(tmpdir(), `livestore-discord-e2e-ledger-${runId}.jsonl`)
  const request = async (operation: string, payload: object): Promise<unknown> => {
    const result = await input.runCommand(input.executable, [
      operation,
      '--request-json',
      JSON.stringify(withContext(payload)),
      '--run-id',
      runId,
      '--ledger',
      ledgerPath,
    ])
    if (result.exitCode !== 0) {
      let reason: string | undefined
      let status: number | undefined
      let discordCode: number | undefined
      let step: number | undefined
      try {
        const decoded: unknown = JSON.parse(result.stdout)
        if (typeof decoded === 'object' && decoded !== null && 'error' in decoded) {
          const error = decoded.error
          if (typeof error === 'object' && error !== null) {
            if ('reason' in error && typeof error.reason === 'string') {
              const allowed = [
                'operator-declined',
                'capture-navigate-failed',
                'capture-wait-failed',
                'capture-click-failed',
                'capture-evaluate-failed',
                'capture-press-failed',
                'capture-fill-failed',
                'capture-type-failed',
                'discord-rest',
              ]
              if (allowed.includes(error.reason) === true) reason = error.reason
            }
            if (
              'status' in error &&
              typeof error.status === 'number' &&
              Number.isInteger(error.status) === true &&
              error.status >= 100 &&
              error.status <= 599
            )
              status = error.status
            if (
              'discordCode' in error &&
              typeof error.discordCode === 'number' &&
              Number.isSafeInteger(error.discordCode) === true &&
              error.discordCode >= 0
            )
              discordCode = error.discordCode
            if (
              'step' in error &&
              typeof error.step === 'number' &&
              Number.isInteger(error.step) === true &&
              error.step >= 0 &&
              error.step <= 10
            )
              step = error.step
          }
        }
      } catch {
        // Unstructured output is deliberately not included in receipts.
      }
      if (
        result.exitCode === 7 &&
        operation.startsWith('resolve-') === false &&
        (reason === undefined || reason === 'operator-declined')
      ) {
        throw new E2EPrerequisiteUnavailableError('No human accepted the handoff request')
      }
      throw new BrokerOperationFailure(reason ?? 'broker-exit', result.exitCode, status, discordCode, step)
    }
    try {
      return result.stdout.trim() === '' ? undefined : JSON.parse(result.stdout)
    } catch {
      throw new Error('Human handoff broker returned invalid JSON')
    }
  }

  return {
    createMessage: async (payload) => message(await request('create-message', payload)),
    invokeMessageAction: async (payload) => interaction(await request('invoke-message-action', payload)),
    invokeDocs: async (payload) => docs(await request('invoke-docs', payload)),
    resolveMessage: async (message) => {
      resolved(await request('resolve-message', { id: message.id, channelId: message.channelId }), message.id)
    },
    resolveResponse: async (response) => {
      if (response.id === undefined) throw new Error('Ephemeral response has no REST cleanup artifact')
      resolved(await request('resolve-response', { id: response.id, channelId: response.channelId }), response.id)
    },
    resolveThread: async (thread) => {
      resolved(
        await request('resolve-thread', {
          id: thread.id,
          guildId: thread.guildId,
          channelId: thread.parentChannelId,
        }),
        thread.id,
      )
    },
  }
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) {
    throw new Error(`Human handoff broker returned invalid ${label}`)
  }
  return value as Record<string, unknown>
}

const attended = (decoded: Record<string, unknown>, label: string): void => {
  // A broker may either attest a human performed the gesture or that it drove
  // an authenticated official-client session; receipts record which executor
  // ran the scenario, so neither mode can masquerade as the other.
  if (decoded.attendedByHuman !== true && decoded.performedBy !== 'official-client-session') {
    throw new E2EPrerequisiteUnavailableError(`Human handoff broker did not attest an attended ${label}`)
  }
}

const snowflake = (value: unknown, label: string): Snowflake => {
  if (typeof value !== 'string' || /^\d{17,20}$/u.test(value) === false) {
    throw new Error(`Human handoff broker returned invalid ${label}`)
  }
  return value as Snowflake
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Human handoff broker returned invalid ${label}`)
  return value
}

const message = (value: unknown): MessageSnapshot => {
  const decoded = record(value, 'message')
  attended(decoded, 'message action')
  return {
    id: snowflake(decoded.id, 'message id'),
    channelId: snowflake(decoded.channelId, 'message channel'),
    marker: text(decoded.marker, 'message marker'),
    author: 'human',
  }
}

const response = (value: unknown): ResponseSnapshot => {
  const decoded = record(value, 'response')
  if (typeof decoded.hasAnswer !== 'boolean' || typeof decoded.hasSources !== 'boolean') {
    throw new Error('Human handoff broker returned invalid response assertions')
  }
  const fields = {
    channelId: snowflake(decoded.channelId, 'response channel'),
    marker: text(decoded.marker, 'response marker'),
    hasAnswer: decoded.hasAnswer,
    hasSources: decoded.hasSources,
  }
  if (decoded.ephemeral === true && decoded.id === undefined) return { ...fields, ephemeral: true }
  if (decoded.ephemeral !== undefined && decoded.ephemeral !== false)
    throw new Error('Human handoff broker returned invalid response identity')
  return { ...fields, id: snowflake(decoded.id, 'response id') }
}

const thread = (value: unknown): ThreadSnapshot => {
  const decoded = record(value, 'thread')
  return {
    id: snowflake(decoded.id, 'thread id'),
    name: typeof decoded.name === 'string' ? decoded.name : '',
    guildId: snowflake(decoded.guildId, 'thread guild'),
    parentChannelId: snowflake(decoded.parentChannelId, 'thread parent channel'),
    sourceMessageId: snowflake(decoded.sourceMessageId, 'thread source message'),
    marker: text(decoded.marker, 'thread marker'),
  }
}

const interaction = (value: unknown): InteractionResult => {
  const decoded = record(value, 'message action')
  attended(decoded, 'message action')
  if (decoded._tag === 'Denied') return { _tag: 'Denied', response: response(decoded.response) }
  if (decoded._tag === 'Created') {
    return { _tag: 'Created', thread: thread(decoded.thread), response: response(decoded.response) }
  }
  throw new Error('Human handoff broker returned invalid message action tag')
}

const docs = (value: unknown): DocsResult => {
  const decoded = record(value, 'docs result')
  attended(decoded, 'docs command')
  if (decoded._tag !== 'Answered' && decoded._tag !== 'Denied') {
    throw new Error('Human handoff broker returned invalid docs tag')
  }
  if (Array.isArray(decoded.responses) === false || decoded.responses.length === 0) {
    throw new Error('Human handoff broker returned no docs response artifacts')
  }
  const first = response(decoded.responses[0])
  const rest = decoded.responses.slice(1).map(response)
  return { _tag: decoded._tag, responses: [first, ...rest] }
}

const resolved = (value: unknown, expectedId: Snowflake): void => {
  const decoded = record(value, 'artifact resolution result')
  if (decoded.resolved !== true || snowflake(decoded.id, 'artifact resolution id') !== expectedId) {
    throw new Error('Human handoff broker did not confirm correlated artifact resolution')
  }
}
