import fs from 'node:fs/promises'
import path from 'node:path'

import { OtelLiveDummy } from '@livestore/common'
import { Effect, Schema } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { browserMultiSessionRecovery } from './corpus/browser-multi-session-recovery.ts'
import { offlineWriterRecovery } from './corpus/offline-writer-recovery.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { type ScenarioAst, ScenarioRunArtifact } from './model.ts'
import {
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
  [offlineWriterRecovery.id]: offlineWriterRecovery,
  [browserMultiSessionRecovery.id]: browserMultiSessionRecovery,
}

const cli = parseCliOptions(process.argv.slice(2))

const program = Effect.gen(function* () {
  const runOptions = {
    runId: `${cli.scenario.id}-${cli.profile}-${Date.now()}`,
    sourceRevision: process.env.GITHUB_SHA ?? 'working-tree',
  }
  const artifact = yield* runSelectedScenario(cli, runOptions)
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ScenarioRunArtifact))(artifact)
  yield* Effect.tryPromise(async () => {
    await fs.mkdir(path.dirname(cli.outputPath), { recursive: true })
    await fs.writeFile(cli.outputPath, `${encoded}\n`, 'utf8')
  })
  yield* Effect.sync(() => {
    console.log(`Scenario ${artifact.status}: ${artifact.descriptor.scenarioId}`)
    console.log(`Execution: ${cli.profile} + ${cli.backend}`)
    console.log(`Trace records: ${artifact.trace.length}`)
    console.log(`Artifact: ${cli.outputPath}`)
  })
}).pipe(Effect.withSpan('scenario-cli'), Effect.scoped, Effect.provide(OtelLiveDummy))

PlatformNode.NodeRuntime.runMain(program)

function runSelectedScenario(cli: CliOptions, options: { runId: string; sourceRevision: string }) {
  switch (cli.profile) {
    case 'in-process':
      return cli.backend === 'mock'
        ? runInProcessScenario({ scenario: cli.scenario, application: todoApplication, options })
        : runInProcessLocalSyncCfScenario({ scenario: cli.scenario, application: todoApplication, options })
    case 'process':
      return runProcessLocalSyncCfScenario({ scenario: cli.scenario, applicationId: todoApplication.id, options })
    case 'browser':
      return runBrowserLocalSyncCfScenario({ scenario: cli.scenario, applicationId: todoApplication.id, options })
  }
}

function parseCliOptions(args: ReadonlyArray<string>): CliOptions {
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

function readChoice<const TChoices extends ReadonlyArray<string>>(
  args: ReadonlyArray<string>,
  name: string,
  choices: TChoices,
): TChoices[number] | undefined {
  const value = readOption(args, name)
  if (value === undefined) return undefined
  if (choices.includes(value) === false) throw new Error(`Invalid ${name} '${value}'. Expected: ${choices.join(', ')}`)
  return value
}

function readOption(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--') === true) throw new Error(`Missing value for ${name}`)
  return value
}
