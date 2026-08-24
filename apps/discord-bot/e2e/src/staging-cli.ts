import { parseLiveManifest } from "./live-manifest.ts"
import { liveWriteConfirmation, type RunReceipt } from "./model.ts"
import { runDfxLiveStaging, type RunDfxLiveInput } from "./run-dfx-live.ts"

export const stagingCliExit = {
  pass: 0,
  fail: 1,
  usage: 2,
  unrun: 7,
} as const

export const actorTokenEnvironmentVariable = "LIVESTORE_DISCORD_E2E_ACTOR_TOKEN"

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
}

const usage =
  "Usage: pnpm e2e:live -- --live --manifest FILE --confirm-live-write " +
  `${liveWriteConfirmation} [--human-handoff-broker EXECUTABLE]`

const usageError = (message: string): StagingCliResult => ({
  exitCode: stagingCliExit.usage,
  stdout: [],
  stderr: [`CRITICAL usage: ${message}`, usage],
})

const readFlag = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const occurrences = args.flatMap((value, index) => (value === flag ? [index] : []))
  if (occurrences.length !== 1) return undefined
  const value = args[occurrences[0]! + 1]
  return value === undefined || value.startsWith("--") === true ? undefined : value
}

const parseArguments = (
  args: ReadonlyArray<string>,
): { readonly _tag: "Parsed"; readonly value: ParsedArguments } | StagingCliResult => {
  const admitted = new Set(["--live", "--manifest", "--confirm-live-write", "--human-handoff-broker"])
  const unknown = args.find((value) => value.startsWith("--") && !admitted.has(value))
  if (unknown !== undefined) return usageError(`unknown option ${unknown}`)
  if (args.filter((value) => value === "--live").length !== 1) {
    return usageError("live execution requires exactly one --live flag")
  }

  const manifestPath = readFlag(args, "--manifest")
  if (manifestPath === undefined) return usageError("--manifest requires exactly one file path")
  const confirmation = readFlag(args, "--confirm-live-write")
  if (confirmation === undefined) {
    return usageError("--confirm-live-write requires the exact confirmation phrase")
  }
  if (confirmation !== liveWriteConfirmation) {
    return usageError("live-write confirmation does not match")
  }
  const brokerFlags = args.filter((value) => value === "--human-handoff-broker")
  const humanHandoffBrokerExecutable = brokerFlags.length === 0
    ? undefined
    : readFlag(args, "--human-handoff-broker")
  if (brokerFlags.length > 0 && humanHandoffBrokerExecutable === undefined) {
    return usageError("--human-handoff-broker requires exactly one executable path")
  }

  const consumed = new Set([
    "--live",
    "--manifest",
    manifestPath,
    "--confirm-live-write",
    confirmation,
    ...(humanHandoffBrokerExecutable === undefined ? [] : ["--human-handoff-broker", humanHandoffBrokerExecutable]),
  ])
  const positional = args.find((value) => !consumed.has(value))
  if (positional !== undefined) return usageError(`unexpected argument ${positional}`)
  return { _tag: "Parsed", value: { manifestPath, confirmation, humanHandoffBrokerExecutable } }
}

const exitForReceipt = (receipt: RunReceipt): number => {
  switch (receipt.verdict) {
    case "PASS":
      return stagingCliExit.pass
    case "FAIL":
      return stagingCliExit.fail
    case "UNRUN":
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
  const args = input.args[0] === "--" ? input.args.slice(1) : input.args
  const parsed = parseArguments(args)
  if (!("_tag" in parsed)) return parsed

  const readTextFile = input.dependencies?.readTextFile
  if (readTextFile === undefined) {
    return {
      exitCode: stagingCliExit.fail,
      stdout: [],
      stderr: ["CRITICAL staging E2E manifest reader is unavailable"],
    }
  }

  let manifest
  try {
    manifest = parseLiveManifest(JSON.parse(await readTextFile(parsed.value.manifestPath)))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid manifest"
    return usageError(`manifest rejected: ${message}`)
  }

  try {
    const receipt = await (input.dependencies?.run ?? runDfxLiveStaging)({
      manifest,
      confirmation: parsed.value.confirmation,
      actorBotToken: input.environment[actorTokenEnvironmentVariable],
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
      stderr: ["CRITICAL staging E2E runner failed before producing a receipt"],
    }
  }
}
