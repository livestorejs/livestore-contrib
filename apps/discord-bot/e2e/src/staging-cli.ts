import { parseLiveManifest } from './live-manifest.ts'
import {
  fullScenarioSelection,
  isScenarioId,
  isScenarioRung,
  liveWriteConfirmation,
  type RunReceipt,
  type ScenarioId,
  type ScenarioSelection,
} from './model.ts'
import { runDfxLiveStaging, type RunDfxLiveInput } from './run-dfx-live.ts'

export const stagingCliExit = {
  pass: 0,
  fail: 1,
  usage: 2,
  unrun: 7,
} as const

export const actorTokenEnvironmentVariable = 'LIVESTORE_DISCORD_E2E_ACTOR_TOKEN'

/** Only consulted when the manifest names a botAdminEndpoint; never a CLI flag. */
export const adminTokenEnvironmentVariable = 'LIVESTORE_DISCORD_ADMIN_TOKEN'

export interface StagingCliDependencies {
  readonly readTextFile: (path: string) => Promise<string>
  readonly run: (input: RunDfxLiveInput) => Promise<RunReceipt>
}

export interface StagingCliResult {
  readonly exitCode: number
  readonly stdout: ReadonlyArray<string>
  readonly stderr: ReadonlyArray<string>
}

interface ParsedArguments {
  readonly manifestPath: string
  readonly confirmation: string
  readonly humanHandoffBrokerExecutable: string | undefined
  readonly selection: ScenarioSelection
}

const usage =
  'Usage: pnpm e2e:live -- --live --manifest FILE --confirm-live-write ' +
  `${liveWriteConfirmation} [--human-handoff-broker EXECUTABLE] ` +
  '[--rung tracer|unattended|attended|full | --scenario ID [--scenario ID ...]]'

const usageError = (message: string): StagingCliResult => ({
  exitCode: stagingCliExit.usage,
  stdout: [],
  stderr: [`CRITICAL usage: ${message}`, usage],
})


const parseArguments = (
  args: ReadonlyArray<string>,
): { readonly _tag: 'Parsed'; readonly value: ParsedArguments } | StagingCliResult => {
  const manifestPaths: string[] = []
  const confirmations: string[] = []
  const brokerExecutables: string[] = []
  const rungs: string[] = []
  const scenarios: string[] = []
  let liveCount = 0

  for (let index = 0; index < args.length; ) {
    const argument = args[index]!
    if (argument === '--live') {
      liveCount += 1
      index += 1
      continue
    }

    const values =
      argument === '--manifest'
        ? manifestPaths
        : argument === '--confirm-live-write'
          ? confirmations
          : argument === '--human-handoff-broker'
            ? brokerExecutables
            : argument === '--rung'
              ? rungs
              : argument === '--scenario'
                ? scenarios
                : undefined
    if (values === undefined) {
      return usageError(argument.startsWith('--') === true ? `unknown option ${argument}` : `unexpected argument ${argument}`)
    }

    const value = args[index + 1]
    if (value === undefined || value.startsWith('--') === true) {
      return usageError(`${argument} requires a value`)
    }
    values.push(value)
    index += 2
  }

  if (liveCount !== 1) return usageError('live execution requires exactly one --live flag')
  if (manifestPaths.length !== 1) return usageError('--manifest requires exactly one file path')
  if (confirmations.length !== 1) {
    return usageError('--confirm-live-write requires the exact confirmation phrase')
  }
  const manifestPath = manifestPaths[0]!
  const confirmation = confirmations[0]!
  if (confirmation !== liveWriteConfirmation) return usageError('live-write confirmation does not match')
  if (brokerExecutables.length > 1) {
    return usageError('--human-handoff-broker requires at most one executable path')
  }
  if (rungs.length > 1) return usageError('--rung may be specified only once')
  if (rungs.length > 0 && scenarios.length > 0) {
    return usageError('--rung and --scenario are mutually exclusive')
  }
  if (new Set(scenarios).size !== scenarios.length) {
    return usageError('each --scenario value may be selected only once')
  }

  let selection = fullScenarioSelection
  const rung = rungs[0]
  if (rung !== undefined) {
    if (isScenarioRung(rung) === false) return usageError(`invalid rung ${rung}`)
    selection = { _tag: 'Rung', rung }
  } else if (scenarios.length > 0) {
    const selectedScenarios: ScenarioId[] = []
    for (const scenario of scenarios) {
      if (isScenarioId(scenario) === false) return usageError(`invalid scenario ${scenario}`)
      selectedScenarios.push(scenario)
    }
    selection = { _tag: 'Scenarios', scenarios: selectedScenarios }
  }

  return {
    _tag: 'Parsed',
    value: {
      manifestPath,
      confirmation,
      humanHandoffBrokerExecutable: brokerExecutables[0],
      selection,
    },
  }
}

const exitForReceipt = (receipt: RunReceipt): number => {
  switch (receipt.verdict) {
    case 'PASS':
      return stagingCliExit.pass
    case 'FAIL':
      return stagingCliExit.fail
    case 'UNRUN':
      return stagingCliExit.unrun
  }
}

/**
 * Testable staging entrypoint. The token has exactly one admitted source: the
 * inherited environment populated by the approved op-proxy wrapper.
 */
export const runStagingCli = async (input: {
  readonly args: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly dependencies?: Partial<StagingCliDependencies>
}): Promise<StagingCliResult> => {
  // pnpm may preserve the conventional option separator for script arguments.
  const args = input.args[0] === '--' ? input.args.slice(1) : input.args
  const parsed = parseArguments(args)
  if (!('_tag' in parsed)) return parsed

  const readTextFile = input.dependencies?.readTextFile
  if (readTextFile === undefined) {
    return {
      exitCode: stagingCliExit.fail,
      stdout: [],
      stderr: ['CRITICAL staging E2E manifest reader is unavailable'],
    }
  }

  let manifest
  try {
    manifest = parseLiveManifest(JSON.parse(await readTextFile(parsed.value.manifestPath)))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'invalid manifest'
    return usageError(`manifest rejected: ${message}`)
  }

  try {
    const receipt = await (input.dependencies?.run ?? runDfxLiveStaging)({
      manifest,
      confirmation: parsed.value.confirmation,
      actorBotToken: input.environment[actorTokenEnvironmentVariable],
      adminToken: input.environment[adminTokenEnvironmentVariable],
      selection: parsed.value.selection,
      humanAssisted: parsed.value.humanHandoffBrokerExecutable !== undefined,
      ...(parsed.value.humanHandoffBrokerExecutable === undefined
        ? {}
        : { humanHandoffBrokerExecutable: parsed.value.humanHandoffBrokerExecutable }),
    })
    return {
      exitCode: exitForReceipt(receipt),
      stdout: [JSON.stringify(receipt)],
      stderr: [],
    }
  } catch {
    return {
      exitCode: stagingCliExit.fail,
      stdout: [],
      stderr: ['CRITICAL staging E2E runner failed before producing a receipt'],
    }
  }
}
