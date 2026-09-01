import type { ScenarioAst } from '../../model.ts'
import { normalizeScenario, scenarioIdFromFileName, type ScenarioSource } from '../../scenario.ts'
import multiSessionRecoverySource from './retained/examples/multi-session-recovery.scenario.ts'
import offlineWriterRecoverySource from './retained/examples/offline-writer-recovery.scenario.ts'
import concurrentHotelBookingSource from './retained/findings/concurrent-hotel-booking.scenario.ts'
import largePayloadRecoverySource from './retained/findings/large-payload-recovery.scenario.ts'
import manyWriterConvergenceSource from './retained/findings/many-writer-convergence.scenario.ts'
import pendingTailRecoverySource from './retained/findings/pending-tail-recovery.scenario.ts'

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
  {
    kind: 'example',
    file: new URL('./retained/examples/offline-writer-recovery.scenario.ts', import.meta.url),
    source: offlineWriterRecoverySource,
  },
  {
    kind: 'example',
    file: new URL('./retained/examples/multi-session-recovery.scenario.ts', import.meta.url),
    source: multiSessionRecoverySource,
  },
  {
    kind: 'finding',
    findingId: 'SF-01',
    file: new URL('./retained/findings/concurrent-hotel-booking.scenario.ts', import.meta.url),
    source: concurrentHotelBookingSource,
  },
  {
    kind: 'finding',
    findingId: 'SF-02',
    file: new URL('./retained/findings/pending-tail-recovery.scenario.ts', import.meta.url),
    source: pendingTailRecoverySource,
  },
  {
    kind: 'finding',
    findingId: 'SF-03',
    file: new URL('./retained/findings/many-writer-convergence.scenario.ts', import.meta.url),
    source: manyWriterConvergenceSource,
  },
  {
    kind: 'finding',
    findingId: 'SF-04',
    file: new URL('./retained/findings/large-payload-recovery.scenario.ts', import.meta.url),
    source: largePayloadRecoverySource,
  },
] as const satisfies ReadonlyArray<{
  readonly kind: 'example' | 'finding'
  readonly findingId?: RetainedScenarioEntry['findingId']
  readonly file: URL
  readonly source: ScenarioSource
}>

const compile = (source: (typeof sources)[number], options: RetainedScenarioCompileOptions = {}): ScenarioAst =>
  normalizeScenario(source.source, {
    id: scenarioIdFromFileName(source.file.pathname),
    ...options,
  })

export const retainedScenarioCatalog: ReadonlyArray<RetainedScenarioEntry> = sources.map((source) => ({
  kind: source.kind,
  ...('findingId' in source ? { findingId: source.findingId } : {}),
  scenario: compile(source),
}))

export const scenarioCorpus: ReadonlyArray<ScenarioAst> = retainedScenarioCatalog.map(({ scenario }) => scenario)

const sourcesById = new Map(
  sources.map((source) => [
    source.file.pathname
      .split('/')
      .at(-1)!
      .replace(/\.scenario\.ts$/, ''),
    source,
  ]),
)
const scenariosById = new Map(scenarioCorpus.map((scenario) => [scenario.id, scenario]))

if (sourcesById.size !== sources.length) throw new Error('Scenario filename-derived IDs must be unique')

export const getScenario = (scenarioId: string, options: RetainedScenarioCompileOptions = {}): ScenarioAst => {
  const source = sourcesById.get(scenarioId)
  if (source !== undefined) {
    if (options.parameters === undefined && options.seed === undefined) return scenariosById.get(scenarioId)!
    return compile(source, options)
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
