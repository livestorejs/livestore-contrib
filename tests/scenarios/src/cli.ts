import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { OtelLiveDummy } from '@livestore/common'
import { Effect, Schema } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { backendOutageRecovery } from './corpus/backend-outage-recovery.ts'
import { browserMultiSessionRecovery } from './corpus/browser-multi-session-recovery.ts'
import { lateClientCatchUp } from './corpus/late-client-catch-up.ts'
import { offlineWriterRecovery } from './corpus/offline-writer-recovery.ts'
import { seededTodoWorkload } from './corpus/seeded-todo-workload.ts'
import { sharedTodoWorkday } from './corpus/shared-todo-workday.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { type ScenarioAst, ScenarioRunArtifact } from './model.ts'
import {
  type RunScenarioOptions,
  runBrowserLocalSyncCfScenario,
  runInProcessLocalSyncCfScenario,
  runInProcessScenario,
  runProcessLocalSyncCfScenario,
} from './runner.ts'

type ParticipantProfile = 'in-process' | 'process' | 'browser'
type SyncBackend = 'mock' | 'local-sync-cf'

interface CliOptions {
  readonly profile: ParticipantProfile
  readonly backend: SyncBackend
  readonly scenario: ScenarioAst
  readonly outputPath: string
}

const scenarios: Readonly<Record<string, ScenarioAst>> = {
  [backendOutageRecovery.id]: backendOutageRecovery,
  [offlineWriterRecovery.id]: offlineWriterRecovery,
  [seededTodoWorkload.id]: seededTodoWorkload,
  [browserMultiSessionRecovery.id]: browserMultiSessionRecovery,
  [lateClientCatchUp.id]: lateClientCatchUp,
  [sharedTodoWorkday.id]: sharedTodoWorkday,
}

const runSelectedScenario = (options: CliOptions, runOptions: RunScenarioOptions) => {
  switch (options.profile) {
    case 'in-process':
      return options.backend === 'mock'
        ? runInProcessScenario({ scenario: options.scenario, application: todoApplication, options: runOptions })
        : runInProcessLocalSyncCfScenario({
            scenario: options.scenario,
            application: todoApplication,
            options: runOptions,
          })
    case 'process':
      return runProcessLocalSyncCfScenario({
        scenario: options.scenario,
        applicationId: todoApplication.id,
        workloads: todoApplication.workloads,
        options: runOptions,
      })
    case 'browser':
      return runBrowserLocalSyncCfScenario({
        scenario: options.scenario,
        applicationId: todoApplication.id,
        workloads: todoApplication.workloads,
        options: runOptions,
      })
  }
}

const parseCliOptions = (args: ReadonlyArray<string>): CliOptions => {
  if (args.includes('--help') === true || args.includes('-h') === true) {
    console.log(`Usage: pnpm scenario:run [options]

Options:
  --profile <in-process|process|browser>       Participant placement (default: in-process)
  --backend <mock|local-sync-cf>              Sync backend (defaults by profile)
  --scenario <scenario-id>                    Scenario (default: offline-writer-recovery)
  --output <path>                             Artifact output path

Scenarios:
  ${Object.keys(scenarios).join('\n  ')}`)
    process.exit(0)
  }

  const profile = readChoice(args, '--profile', ['in-process', 'process', 'browser'] as const) ?? 'in-process'
  const backend =
    readChoice(args, '--backend', ['mock', 'local-sync-cf'] as const) ??
    (profile === 'in-process' ? 'mock' : 'local-sync-cf')
  if (profile !== 'in-process' && backend !== 'local-sync-cf') {
    throw new Error(`${profile} requires --backend local-sync-cf`)
  }

  const scenarioId = readOption(args, '--scenario') ?? offlineWriterRecovery.id
  const scenario = scenarios[scenarioId]
  if (scenario === undefined)
    throw new Error(`Unknown scenario '${scenarioId}'. Expected: ${Object.keys(scenarios).join(', ')}`)

  const positionalOutput = args[0]?.startsWith('-') === false ? args[0] : undefined
  const output = readOption(args, '--output') ?? positionalOutput ?? `artifacts/${scenario.id}.json`

  return { profile, backend, scenario, outputPath: path.resolve(output) }
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

const cli = parseCliOptions(process.argv.slice(2))

const program = Effect.gen(function* () {
  const runOptions = {
    runId: `${cli.scenario.id}-${cli.profile}-${Date.now()}`,
    sourceRevision: process.env.GITHUB_SHA ?? 'working-tree',
    onProgress:
      process.env.SCENARIO_PROGRESS === '1'
        ? (progress: Parameters<NonNullable<RunScenarioOptions['onProgress']>>[0]) => {
            console.log(
              `${progress.stage === 'started' ? '→' : '✓'} ${progress.stepNumber}/${progress.totalSteps} ${progress.phaseId}/${progress.stepId}`,
            )
          }
        : undefined,
  }
  const artifact = yield* runSelectedScenario(cli, runOptions)
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ScenarioRunArtifact))(artifact)
  yield* Effect.tryPromise(async () => {
    await fs.mkdir(path.dirname(cli.outputPath), { recursive: true })
    await fs.writeFile(cli.outputPath, `${encoded}\n`, 'utf8')
    await refreshArtifactCatalog(cli.outputPath)
  })
  yield* Effect.sync(() => {
    console.log(`Scenario ${artifact.status}: ${artifact.descriptor.scenarioId}`)
    console.log(`Execution: ${cli.profile} + ${cli.backend}`)
    console.log(`Trace records: ${artifact.trace.length}`)
    console.log(`Artifact: ${cli.outputPath}`)
    if (artifact.status === 'failed') process.exitCode = 1
  })
}).pipe(Effect.withSpan('scenario-cli'), Effect.scoped, Effect.provide(OtelLiveDummy))

interface ArtifactCatalogEntry {
  readonly file: string
  readonly label: string
  readonly scenarioId: string
  readonly profile: ParticipantProfile
  readonly backend: SyncBackend
  readonly applicationEventCount: number
  readonly traceRecordCount: number
  readonly status: 'passed' | 'failed'
}

/** Keeps the viewer catalog derived from the artifacts on disk, including artifacts from earlier runs. */
const refreshArtifactCatalog = async (outputPath: string): Promise<void> => {
  const artifactDirectory = path.resolve(import.meta.dirname, '../artifacts')
  if (path.dirname(outputPath) !== artifactDirectory) return

  const entries = await Promise.all(
    (await fs.readdir(artifactDirectory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith('.json') || entry.name.endsWith('.json.gz')) &&
          entry.name !== 'catalog.json',
      )
      .map(async (entry): Promise<ArtifactCatalogEntry | undefined> => {
        try {
          const fileData = await fs.readFile(path.join(artifactDirectory, entry.name))
          const artifactJson =
            entry.name.endsWith('.gz') === true ? gunzipSync(fileData).toString('utf8') : fileData.toString('utf8')
          const artifact = Schema.decodeUnknownSync(Schema.fromJsonString(ScenarioRunArtifact))(artifactJson)
          const profile = artifact.descriptor.execution.participantProfile
          const backend = artifact.descriptor.execution.syncBackend
          return {
            file: entry.name,
            label: `${artifact.descriptor.scenarioId} · ${profile} · ${backend}${entry.name.startsWith('reference-') === true ? ' · reference' : ''}`,
            scenarioId: artifact.descriptor.scenarioId,
            profile,
            backend,
            applicationEventCount: artifact.trace.filter((record) => record.payload._tag === 'action.completed').length,
            traceRecordCount: artifact.trace.length,
            status: artifact.status,
          }
        } catch {
          return undefined
        }
      }),
  )
  const catalog = {
    version: 1,
    entries: entries
      .filter((entry): entry is ArtifactCatalogEntry => entry !== undefined)
      .toSorted((left, right) => left.label.localeCompare(right.label) || left.file.localeCompare(right.file)),
  }
  await fs.writeFile(path.join(artifactDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
}

PlatformNode.NodeRuntime.runMain(program)
