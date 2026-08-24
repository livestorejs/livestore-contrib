import { Cause, Effect, Exit, Schema } from 'effect'

import type { BotControlClient } from '../control/contract.ts'
import {
  ControlError,
  ControlResult,
  type ControlError as ControlErrorType,
  type ControlResult as ControlResultType,
} from '../control/schema.ts'
import { CliExit, type CliIo, type OutputMode } from './model.ts'
import { parseCli } from './parse.ts'

const encodeResult = Schema.encodeSync(ControlResult)
const encodeError = Schema.encodeSync(ControlError)

export const runCli = (args: readonly string[], client: BotControlClient, io: CliIo): Effect.Effect<number> =>
  Effect.gen(function* () {
    const parsed = parseCli(args)
    if (parsed._tag === 'Help') {
      io.stdout(parsed.text)
      return CliExit.Success
    }
    if (parsed._tag === 'UsageError') {
      io.stderr(`CRITICAL usage: ${parsed.message}`)
      io.stderr(parsed.help)
      return CliExit.Usage
    }

    const exit = yield* Effect.exit(parsed.invocation.run(client))
    if (Exit.isSuccess(exit) === true) {
      renderResult(exit.value, parsed.invocation.output, io)
      return exit.value._tag === 'Unrun' ? CliExit.Unrun : CliExit.Success
    }
    const failure = Cause.findErrorOption(exit.cause)
    if (failure._tag === 'Some') {
      renderError(failure.value, parsed.invocation.output, io)
      return exitForError(failure.value)
    }
    io.stderr(`CRITICAL runtime defect: ${Cause.pretty(exit.cause)}`)
    return CliExit.UnexpectedDefect
  })

const renderResult = (result: ControlResultType, output: OutputMode, io: CliIo) => {
  if (machineOutput(output, io) === true) {
    io.stdout(JSON.stringify(encodeResult(result)))
    return
  }
  io.stdout(`${result._tag.toUpperCase()} ${result.summary}`)
  if (result.correlationId !== undefined) io.stdout(`correlation: ${result.correlationId}`)
  if (result.receiptId !== undefined) io.stdout(`receipt: ${result.receiptId}`)
  if (result.nextCommand !== undefined) io.stdout(`next: ${result.nextCommand}`)
}

const renderError = (error: ControlErrorType, output: OutputMode, io: CliIo) => {
  if (machineOutput(output, io) === true) io.stdout(JSON.stringify(encodeError(error)))
  else {
    io.stderr(`CRITICAL ${error._tag}: ${error.message}`)
    if (error._tag === 'ControlAmbiguousOutcome' && error.correlationId !== undefined) {
      io.stderr(`correlation: ${error.correlationId}`)
    }
  }
}

const exitForError = (error: ControlErrorType): number => {
  switch (error._tag) {
    case 'InvalidControlInput':
      return CliExit.Usage
    case 'ControlAuthorizationRejected':
      return CliExit.Rejected
    case 'ControlDependencyUnavailable':
      return CliExit.Unavailable
    case 'ControlApplicationFailure':
      return CliExit.ApplicationFailure
    case 'ControlAmbiguousOutcome':
      return CliExit.Ambiguous
    case 'ControlGateUnrun':
      return CliExit.Unrun
  }
}

const machineOutput = (output: OutputMode, io: CliIo) =>
  output === 'json' || output === 'ndjson' || (output === 'auto' && io.isTTY === false)
