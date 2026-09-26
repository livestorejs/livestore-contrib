import type { Effect } from 'effect'

import type { BotControlClient, BotControlOperation } from '../control/contract.ts'
import type { ControlError, ControlResult } from '../control/schema.ts'

export type OutputMode = 'auto' | 'log' | 'json' | 'ndjson'

export type CliIo = {
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
  readonly isTTY?: boolean
}

export type CliInvocation = {
  readonly operation: BotControlOperation
  readonly output: OutputMode
  readonly permitsNdjson: boolean
  readonly run: (client: BotControlClient) => Effect.Effect<ControlResult, ControlError>
}

export type ParseResult =
  | { readonly _tag: 'Help'; readonly text: string }
  | { readonly _tag: 'UsageError'; readonly message: string; readonly help: string }
  | { readonly _tag: 'Invocation'; readonly invocation: CliInvocation }

export const CliExit = {
  Success: 0,
  UnexpectedDefect: 1,
  Usage: 2,
  Rejected: 3,
  Unavailable: 4,
  ApplicationFailure: 5,
  Ambiguous: 6,
  Unrun: 7,
} as const
