import { Schema } from 'effect'

import type { BotControlClient } from '../control/contract.ts'
import { BotControlOperationNames } from '../control/contract.ts'
import {
  DeploymentEnvironment,
  DiscordMessageRef,
  OperatorReason,
  type DiscordMessageRef as DiscordMessageRefType,
} from '../control/schema.ts'
import type { CliInvocation, OutputMode, ParseResult } from './model.ts'

const rootHelp = `livestore-discord - operate the LiveStore Discord bot through Bot control

Usage: livestore-discord <scope> <command> [arguments] [--socket /absolute/path.sock] [--output auto|log|json|ndjson]

Scopes:
  thread   inspect, plan, create, status, or reconcile a source message
  policy   explain automatic-thread policy for a source message
  docs     query the documentation assistant or inspect readiness
  runtime  inspect runtime health and status
  config   validate or show redacted configuration
  auth     show transport-derived operator capabilities
  commands diff or synchronize Discord application commands
  e2e      run the guarded staging live-write gate

Write commands require --apply, --reason, and an explicit environment.
The CLI only calls the authenticated runtime socket; it never calls Discord REST directly.`

/** Every administrative RPC has exactly one discoverable CLI command family. */
export const CliOperationNames = BotControlOperationNames

const helpFor = (scope: string, action?: string) => {
  if (scope === 'thread' && action === 'create') {
    return 'Usage: livestore-discord thread create MESSAGE_URL --environment staging|production --apply --reason TEXT [--name TEXT] [--socket /absolute/path.sock]'
  }
  if (scope === 'thread' && action === 'reconcile') {
    return 'Usage: livestore-discord thread reconcile MESSAGE_URL|--all [--state STATE --limit N] [--environment ENV --apply] --reason TEXT'
  }
  if (scope === 'commands' && action === 'sync') {
    return 'Usage: livestore-discord commands sync --environment staging|production --apply --reason TEXT'
  }
  if (scope === 'e2e') {
    return 'Usage: livestore-discord e2e run --environment staging --apply --reason TEXT --confirm-live-write'
  }
  return rootHelp
}

export const parseCli = (args: readonly string[]): ParseResult => {
  if (args.length === 0 || args.includes('--help') === true || args.includes('-h') === true) {
    return { _tag: 'Help', text: args.length === 0 ? rootHelp : helpFor(args[0] ?? '', args[1]) }
  }

  const outputResult = parseOutput(args)
  if (outputResult._tag === 'UsageError') return outputResult
  const output = outputResult.output
  const scope = args[0]
  const action = args[1]
  const usage = (message: string): ParseResult => ({
    _tag: 'UsageError',
    message,
    help: helpFor(scope ?? '', action),
  })

  const source = () => parseSource(args, 2)
  const readSource = (): DiscordMessageRefType | ParseResult => {
    const result = source()
    return result._tag === 'UsageError' ? usage(result.message) : result.source
  }
  const invocation = (
    operation: CliInvocation['operation'],
    run: CliInvocation['run'],
    permitsNdjson = false,
  ): ParseResult =>
    output === 'ndjson' && permitsNdjson === false
      ? usage('--output ndjson is only valid for a streaming or list command')
      : { _tag: 'Invocation', invocation: { operation, output, permitsNdjson, run } }

  if (scope === 'thread' && action === 'inspect') {
    const value = readSource()
    if (isParseResult(value) === true) return value
    return invocation('ThreadInspect', (client) => client.ThreadInspect({ source: value }))
  }
  if (scope === 'thread' && action === 'plan') {
    const value = readSource()
    if (isParseResult(value) === true) return value
    return invocation('ThreadPlan', (client) =>
      client.ThreadPlan({
        source: value,
        name: readFlag(args, '--name'),
        noAi: args.includes('--no-ai'),
      }),
    )
  }
  if (scope === 'thread' && action === 'create') {
    const value = readSource()
    if (isParseResult(value) === true) return value
    const guard = parseMutationGuard(args)
    if (guard._tag === 'UsageError') return usage(guard.message)
    return invocation('ThreadCreate', (client) =>
      client.ThreadCreate({
        source: value,
        ...guard.value,
        name: readFlag(args, '--name'),
      }),
    )
  }
  if (scope === 'thread' && action === 'status') {
    const value = readSource()
    if (isParseResult(value) === true) return value
    return invocation('ThreadStatus', (client) => client.ThreadStatus({ source: value }))
  }
  if (scope === 'thread' && action === 'reconcile') {
    const all = args.includes('--all') === true
    const sourceResult = all === true ? undefined : readSource()
    if (sourceResult !== undefined && isParseResult(sourceResult) === true) return sourceResult
    const apply = args.includes('--apply') === true
    const reason = apply === true ? decodeReason(readFlag(args, '--reason')) : undefined
    if (reason?._tag === 'UsageError') return usage(reason.message)
    const environmentResult = apply === true ? decodeEnvironment(readFlag(args, '--environment')) : undefined
    if (environmentResult?._tag === 'UsageError') return usage(environmentResult.message)
    const state = readFlag(args, '--state')
    if (state !== undefined && ['creating', 'unknown_external'].includes(state) === false) {
      return usage('--state must be creating or unknown_external')
    }
    const limit = readOptionalPositiveInt(args, '--limit')
    if (typeof limit === 'string') return usage(limit)
    return invocation(
      'ThreadReconcile',
      (client) =>
        client.ThreadReconcile({
          source: sourceResult,
          all,
          state: state as 'creating' | 'unknown_external' | undefined,
          limit,
          apply,
          environment: environmentResult?.value,
          reason: reason?.value,
        }),
      all,
    )
  }
  if (scope === 'policy' && action === 'explain') {
    const value = readSource()
    if (isParseResult(value) === true) return value
    return invocation('ThreadPolicyExplain', (client) => client.ThreadPolicyExplain({ source: value }))
  }
  if (scope === 'docs' && action === 'query') {
    const query = args[2]?.trim()
    if (query === undefined || query.length === 0) return usage('docs query requires a non-empty query')
    return invocation('DocsQuery', (client) =>
      client.DocsQuery({ query, refreshCorpus: args.includes('--refresh-corpus') }),
    )
  }
  if (scope === 'docs' && action === 'status') {
    return invocation('DocsStatus', (client) => client.DocsStatus({}))
  }
  if (scope === 'runtime' && action === 'health') {
    const watch = args.includes('--watch') === true
    return invocation('RuntimeHealth', (client) => client.RuntimeHealth({ watch }), watch)
  }
  if (scope === 'runtime' && action === 'status') {
    return invocation('RuntimeStatus', (client) => client.RuntimeStatus({}))
  }
  if (scope === 'config' && action === 'validate') {
    return invocation('ConfigValidate', (client) => client.ConfigValidate({ file: readFlag(args, '--file') }))
  }
  if (scope === 'config' && action === 'show') {
    return invocation('EffectiveConfig', (client) => client.EffectiveConfig({}))
  }
  if (scope === 'auth' && action === 'status') {
    return invocation('AuthStatus', (client) => client.AuthStatus({}))
  }
  if (scope === 'commands' && action === 'diff') {
    return invocation('ApplicationCommandsDiff', (client) => client.ApplicationCommandsDiff({}))
  }
  if (scope === 'commands' && action === 'sync') {
    const guard = parseMutationGuard(args)
    if (guard._tag === 'UsageError') return usage(guard.message)
    return invocation('ApplicationCommandsSync', (client) => client.ApplicationCommandsSync(guard.value))
  }
  if (scope === 'e2e' && action === 'run') {
    const guard = parseMutationGuard(args)
    if (guard._tag === 'UsageError') return usage(guard.message)
    if (guard.value.environment !== 'staging') return usage('e2e run only permits --environment staging')
    if (args.includes('--confirm-live-write') === false) return usage('e2e run requires --confirm-live-write')
    return invocation('StagingE2ERun', (client) =>
      client.StagingE2ERun({
        ...guard.value,
        environment: 'staging',
        confirmLiveWrite: true,
      }),
    )
  }
  return usage(`unknown command: ${[scope, action].filter(Boolean).join(' ')}`)
}

export const decodeMessageUrl = (raw: string): DiscordMessageRefType => {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || (url.hostname !== 'discord.com' && url.hostname !== 'www.discord.com')) {
    throw new TypeError('expected an https://discord.com/channels/... message URL')
  }
  const match = /^\/channels\/(\d{5,22})\/(\d{5,22})\/(\d{5,22})\/?$/.exec(url.pathname)
  if (match === null) throw new TypeError('message URL must contain guild, channel, and message IDs')
  return Schema.decodeUnknownSync(DiscordMessageRef)({
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
  })
}

const parseSource = (
  args: readonly string[],
  position: number,
):
  | { readonly _tag: 'Source'; readonly source: DiscordMessageRefType }
  | { readonly _tag: 'UsageError'; readonly message: string } => {
  try {
    const positional = args[position]
    if (positional !== undefined && positional.startsWith('--') === false) {
      return { _tag: 'Source', source: decodeMessageUrl(positional) }
    }
    return {
      _tag: 'Source',
      source: Schema.decodeUnknownSync(DiscordMessageRef)({
        guildId: readFlag(args, '--guild'),
        channelId: readFlag(args, '--channel'),
        messageId: readFlag(args, '--message'),
      }),
    }
  } catch (cause) {
    return { _tag: 'UsageError', message: cause instanceof Error ? cause.message : 'invalid message reference' }
  }
}

const parseMutationGuard = (args: readonly string[]) => {
  if (args.includes('--apply') === false)
    return { _tag: 'UsageError', message: 'write command requires --apply' } as const
  const environment = decodeEnvironment(readFlag(args, '--environment'))
  if (environment._tag === 'UsageError') return environment
  const reason = decodeReason(readFlag(args, '--reason'))
  if (reason._tag === 'UsageError') return reason
  return {
    _tag: 'Guard',
    value: { apply: true as const, environment: environment.value, reason: reason.value },
  } as const
}

const decodeEnvironment = (value: string | undefined) => {
  try {
    return { _tag: 'Environment', value: Schema.decodeUnknownSync(DeploymentEnvironment)(value) } as const
  } catch {
    return { _tag: 'UsageError', message: 'write command requires --environment staging|production' } as const
  }
}

const decodeReason = (value: string | undefined) => {
  try {
    return { _tag: 'Reason', value: Schema.decodeUnknownSync(OperatorReason)(value) } as const
  } catch {
    return {
      _tag: 'UsageError',
      message: 'write command requires --reason with at least 3 non-whitespace characters',
    } as const
  }
}

const parseOutput = (args: readonly string[]) => {
  const value = readFlag(args, '--output') ?? 'auto'
  return ['auto', 'log', 'json', 'ndjson'].includes(value) === true
    ? ({ _tag: 'Output', output: value as OutputMode } as const)
    : ({ _tag: 'UsageError', message: '--output must be auto, log, json, or ndjson', help: rootHelp } as const)
}

const readFlag = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

const readOptionalPositiveInt = (args: readonly string[], flag: string): number | undefined | string => {
  const raw = readFlag(args, flag)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) === true && value > 0 ? value : `${flag} must be a positive integer`
}

const isParseResult = (value: DiscordMessageRefType | ParseResult): value is ParseResult => '_tag' in value

// This keeps closures checked against the complete generated client type.
void ({} as BotControlClient)
