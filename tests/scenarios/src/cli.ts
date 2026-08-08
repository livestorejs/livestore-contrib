import fs from 'node:fs/promises'
import path from 'node:path'

import { OtelLiveDummy } from '@livestore/common'
import { Effect, Schema } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { writeArtifactCatalog } from './artifact-catalog-fs.ts'
import type { CloudSyncCfScenarioBackendOptions } from './backends.ts'
import { ensureCloudSyncCf } from './cloud-sync-cf.ts'
import { getScenarioApplication, scenarioApplications } from './corpus/applications/registry.ts'
import { getScenario, retainedScenarioCatalog } from './corpus/scenarios/registry.ts'
import { compileScenarioFileSync } from './dsl/file.ts'
import { type ScenarioAst, ScenarioRunArtifact } from './model.ts'
import {
  type RunScenarioOptions,
  runBrowserCloudSyncCfScenario,
  runBrowserLocalSyncCfScenario,
  runInProcessCloudSyncCfScenario,
  runInProcessLocalSyncCfScenario,
  runInProcessScenario,
  runProcessCloudSyncCfScenario,
  runProcessLocalSyncCfScenario,
} from './runner.ts'

type ParticipantProfile = 'in-process' | 'process' | 'browser'
type SyncBackend = 'mock' | 'local-sync-cf' | 'cloud-sync-cf'

interface CliOptions {
  readonly profile: ParticipantProfile
  readonly backend: SyncBackend
  readonly scenario: ScenarioAst
  readonly outputPath: string
  readonly stabilizationTimeoutMs: number
}

const runSelectedScenario = (
  options: CliOptions,
  runOptions: RunScenarioOptions,
  cloud: CloudSyncCfScenarioBackendOptions | undefined,
) => {
  const application = getScenarioApplication(options.scenario.applicationId)
  switch (options.profile) {
    case 'in-process': {
      if (options.backend === 'mock') {
        return runInProcessScenario({ scenario: options.scenario, application, options: runOptions })
      }
      if (options.backend === 'local-sync-cf') {
        return runInProcessLocalSyncCfScenario({
          scenario: options.scenario,
          application,
          options: runOptions,
        })
      }
      return runInProcessCloudSyncCfScenario({
        scenario: options.scenario,
        application,
        cloud: requireCloud(cloud),
        options: runOptions,
      })
    }
    case 'process':
      return options.backend === 'local-sync-cf'
        ? runProcessLocalSyncCfScenario({
            scenario: options.scenario,
            applicationId: application.id,
            options: runOptions,
          })
        : runProcessCloudSyncCfScenario({
            scenario: options.scenario,
            applicationId: application.id,
            cloud: requireCloud(cloud),
            options: runOptions,
          })
    case 'browser':
      return options.backend === 'local-sync-cf'
        ? runBrowserLocalSyncCfScenario({
            scenario: options.scenario,
            applicationId: application.id,
            options: runOptions,
          })
        : runBrowserCloudSyncCfScenario({
            scenario: options.scenario,
            applicationId: application.id,
            cloud: requireCloud(cloud),
            options: runOptions,
          })
  }
}

const requireCloud = (cloud: CloudSyncCfScenarioBackendOptions | undefined): CloudSyncCfScenarioBackendOptions => {
  if (cloud === undefined) throw new Error('Cloud sync-cf backend was not provisioned')
  return cloud
}

const parseCliOptions = async (args: ReadonlyArray<string>): Promise<CliOptions> => {
  if (args.includes('--help') === true || args.includes('-h') === true) {
    console.log(`Usage: pnpm scenario:run [options]

Options:
  --core-ref <branch|tag|commit>              Run against a dependency-compatible LiveStore Git ref
  --core-path <path>                          Run against an installed local LiveStore worktree
  --profile <in-process|process|browser>       Participant placement (default: in-process)
  --backend <mock|local-sync-cf|cloud-sync-cf> Sync backend (defaults by profile)
  --scenario <scenario-id>                    Retained Scenario (default: offline-writer-recovery)
  --scenario-file <path>                      Local .scenario source file
  --set <name=value>                          Override a declared Scenario parameter (repeatable)
  --stabilization-timeout <duration>           Run-policy timeout for settle/stabilization (default: 60s)
  --output <path>                             Artifact output path

Scenarios:
  ${retainedScenarioCatalog
    .map(({ findingId, kind, scenario }) => [findingId ?? kind, scenario.id, scenario.description].join(' · '))
    .join('\n  ')}`)
    process.exit(0)
  }

  const profile = readChoice(args, '--profile', ['in-process', 'process', 'browser'] as const) ?? 'in-process'
  const backend =
    readChoice(args, '--backend', ['mock', 'local-sync-cf', 'cloud-sync-cf'] as const) ??
    (profile === 'in-process' ? 'mock' : 'local-sync-cf')
  if (profile !== 'in-process' && backend === 'mock') {
    throw new Error(`${profile} requires a sync-cf backend`)
  }

  const scenarioId = readOption(args, '--scenario')
  const scenarioFile = readOption(args, '--scenario-file')
  if (scenarioId !== undefined && scenarioFile !== undefined) {
    throw new Error('Choose either --scenario or --scenario-file, not both')
  }
  const parameters = readParameterOverrides(args)
  const scenario =
    scenarioFile === undefined
      ? getScenario(scenarioId ?? 'offline-writer-recovery', { parameters })
      : loadScenarioFile(path.resolve(scenarioFile), parameters)

  const positionalOutput = args[0]?.startsWith('-') === false ? args[0] : undefined
  const output = readOption(args, '--output') ?? positionalOutput ?? `artifacts/${scenario.id}.json`

  const stabilizationTimeoutMs = parseDuration(readOption(args, '--stabilization-timeout') ?? '60s')

  return { profile, backend, scenario, outputPath: path.resolve(output), stabilizationTimeoutMs }
}

const loadScenarioFile = (file: string, parameters: Readonly<Record<string, string>>): ScenarioAst =>
  compileScenarioFileSync(file, { applications: scenarioApplications, parameters })

const readParameterOverrides = (args: ReadonlyArray<string>): Readonly<Record<string, string>> => {
  const parameters: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const inline = args[index]?.startsWith('--set=') === true ? args[index]!.slice('--set='.length) : undefined
    if (args[index] !== '--set' && inline === undefined) continue
    const assignment = inline ?? args[index + 1]
    const match = assignment === undefined ? null : /^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/.exec(assignment)
    if (match === null) throw new Error('Expected --set name=value')
    parameters[match[1]!] = match[2]!
    if (inline === undefined) index += 1
  }
  return parameters
}

const parseDuration = (source: string): number => {
  const match = /^(\d+)(ms|s|m)$/.exec(source)
  if (match === null)
    throw new Error(`Invalid duration '${source}'. Expected a positive integer followed by ms, s, or m`)
  const value = Number(match[1]) * (match[2] === 'm' ? 60_000 : match[2] === 's' ? 1_000 : 1)
  if (value <= 0) throw new Error(`Duration must be positive: ${source}`)
  return value
}

const readChoice = <const TChoices extends ReadonlyArray<string>>(
  args: ReadonlyArray<string>,
  name: string,
  choices: TChoices,
): TChoices[number] | undefined => {
  const value = readOption(args, name)
  if (value === undefined) return undefined
  if (choices.includes(value) === false) throw new Error(`Invalid ${name} '${value}'. Expected: ${choices.join(', ')}`)
  return value
}

const readOption = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--') === true) throw new Error(`Missing value for ${name}`)
  return value
}

const cli = await parseCliOptions(process.argv.slice(2))

const program = Effect.gen(function* () {
  const runOptions = {
    runId: `${cli.scenario.id}-${cli.profile}-${Date.now()}`,
    sourceRevision: process.env.LIVESTORE_SCENARIO_SOURCE_REVISION ?? process.env.GITHUB_SHA ?? 'working-tree',
    execution: {
      participantProfile: cli.profile,
      syncBackend: cli.backend,
      stateProfile: cli.profile === 'browser' ? ('opfs' as const) : ('sqlite' as const),
      stabilizationTimeoutMs: cli.stabilizationTimeoutMs,
    },
    onProgress:
      process.env.SCENARIO_PROGRESS === '1'
        ? (progress: Parameters<NonNullable<RunScenarioOptions['onProgress']>>[0]) => {
            console.log(
              `${progress.stage === 'started' ? '→' : '✓'} ${progress.instructionNumber}/${progress.totalInstructions} ${progress.instructionId}`,
            )
          }
        : undefined,
  }
  const cloud =
    cli.backend === 'cloud-sync-cf'
      ? yield* Effect.tryPromise(() =>
          ensureCloudSyncCf({
            backendRevision: runOptions.sourceRevision,
            forceDeploy: process.env.SCENARIO_CLOUD_FORCE_DEPLOY === '1',
          }),
        )
      : undefined
  const artifact = yield* runSelectedScenario(cli, runOptions, cloud)
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ScenarioRunArtifact))(artifact)
  yield* Effect.tryPromise(async () => {
    await fs.mkdir(path.dirname(cli.outputPath), { recursive: true })
    await fs.writeFile(cli.outputPath, `${encoded}\n`, 'utf8')
    const artifactDirectory = path.resolve(import.meta.dirname, '../artifacts')
    if (path.dirname(cli.outputPath) === artifactDirectory) await writeArtifactCatalog(artifactDirectory)
  })
  yield* Effect.sync(() => {
    console.log(`Scenario ${artifact.status}: ${artifact.descriptor.scenarioId}`)
    console.log(`Execution: ${cli.profile} + ${cli.backend}`)
    console.log(`Trace records: ${artifact.trace.length}`)
    console.log(`Artifact: ${cli.outputPath}`)
    if (artifact.status === 'failed') process.exitCode = 1
  })
}).pipe(Effect.withSpan('scenario-cli'), Effect.scoped, Effect.provide(OtelLiveDummy))

PlatformNode.NodeRuntime.runMain(program)
