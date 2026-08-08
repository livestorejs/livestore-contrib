import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { OtelLiveDummy } from '@livestore/common'
import { Effect, Schema } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { writeArtifactCatalog } from './artifact-catalog-fs.ts'
import type { CloudSyncCfScenarioBackendOptions } from './backends.ts'
import { ensureCloudSyncCf } from './cloud-sync-cf.ts'
import { getScenarioApplication } from './corpus/applications/registry.ts'
import { getScenario, retainedScenarioCatalog } from './corpus/scenarios/registry.ts'
import { defineScenario, type ScenarioAst, ScenarioRunArtifact } from './model.ts'
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
  --scenario-file <path>                      Local TypeScript Scenario module
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
  const scenario =
    scenarioFile === undefined
      ? getScenario(scenarioId ?? 'offline-writer-recovery')
      : await loadScenarioFile(path.resolve(scenarioFile))

  const positionalOutput = args[0]?.startsWith('-') === false ? args[0] : undefined
  const output = readOption(args, '--output') ?? positionalOutput ?? `artifacts/${scenario.id}.json`

  return { profile, backend, scenario, outputPath: path.resolve(output) }
}

const loadScenarioFile = async (file: string): Promise<ScenarioAst> => {
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  const candidate = module.default ?? module.scenario
  if (candidate === undefined) {
    throw new Error(`Scenario file must export the Scenario as default or as 'scenario': ${file}`)
  }
  return defineScenario(candidate)
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
    onProgress:
      process.env.SCENARIO_PROGRESS === '1'
        ? (progress: Parameters<NonNullable<RunScenarioOptions['onProgress']>>[0]) => {
            console.log(
              `${progress.stage === 'started' ? '→' : '✓'} ${progress.stepNumber}/${progress.totalSteps} ${progress.phaseId}/${progress.stepId}`,
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
