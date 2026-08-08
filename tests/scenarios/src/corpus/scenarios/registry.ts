import { compileScenarioFileSync } from '../../dsl/file.ts'
import type { ScenarioAst } from '../../model.ts'
import { scenarioApplications } from '../applications/registry.ts'

export interface RetainedScenarioEntry {
  readonly kind: 'example' | 'finding'
  readonly findingId?: 'SF-01' | 'SF-02' | 'SF-03' | 'SF-04'
  readonly scenario: ScenarioAst
}

export interface RetainedScenarioCompileOptions {
  readonly parameters?: Readonly<Record<string, string | number | boolean>>
  readonly seed?: number
}

const sources = [
  { kind: 'example', file: new URL('./retained/examples/offline-writer-recovery.scenario', import.meta.url) },
  { kind: 'example', file: new URL('./retained/examples/multi-session-recovery.scenario', import.meta.url) },
  {
    kind: 'finding',
    findingId: 'SF-01',
    file: new URL('./retained/findings/concurrent-hotel-booking.scenario', import.meta.url),
  },
  {
    kind: 'finding',
    findingId: 'SF-02',
    file: new URL('./retained/findings/pending-tail-recovery.scenario', import.meta.url),
  },
  {
    kind: 'finding',
    findingId: 'SF-03',
    file: new URL('./retained/findings/many-writer-convergence.scenario', import.meta.url),
  },
  {
    kind: 'finding',
    findingId: 'SF-04',
    file: new URL('./retained/findings/large-payload-recovery.scenario', import.meta.url),
  },
] as const

const compile = (file: URL, options: RetainedScenarioCompileOptions = {}): ScenarioAst =>
  compileScenarioFileSync(file, { applications: scenarioApplications, ...options })

export const retainedScenarioCatalog: ReadonlyArray<RetainedScenarioEntry> = sources.map((source) => ({
  kind: source.kind,
  ...('findingId' in source ? { findingId: source.findingId } : {}),
  scenario: compile(source.file),
}))

export const scenarioCorpus: ReadonlyArray<ScenarioAst> = retainedScenarioCatalog.map(({ scenario }) => scenario)

const sourcesById = new Map(
  sources.map((source) => [
    source.file.pathname
      .split('/')
      .at(-1)!
      .replace(/\.scenario$/, ''),
    source,
  ]),
)
const scenariosById = new Map(scenarioCorpus.map((scenario) => [scenario.id, scenario]))

if (sourcesById.size !== sources.length) throw new Error('Scenario filename-derived IDs must be unique')

export const getScenario = (scenarioId: string, options: RetainedScenarioCompileOptions = {}): ScenarioAst => {
  const source = sourcesById.get(scenarioId)
  if (source !== undefined) {
    if (options.parameters === undefined && options.seed === undefined) return scenariosById.get(scenarioId)!
    return compile(source.file, options)
  }
  throw new Error(`Unknown scenario '${scenarioId}'. Expected: ${[...sourcesById.keys()].join(', ')}`)
}

export const offlineWriterRecovery = getScenario('offline-writer-recovery')
export const multiSessionRecovery = getScenario('multi-session-recovery')
/** Kept as a source-level export name while the Scenario ID is profile-neutral. */
export const browserMultiSessionRecovery = multiSessionRecovery
export const concurrentHotelBooking = getScenario('concurrent-hotel-booking')
export const pendingTailRecovery = getScenario('pending-tail-recovery')
export const manyWriterConvergence = getScenario('many-writer-convergence')
export const largePayloadRecovery = getScenario('large-payload-recovery')
