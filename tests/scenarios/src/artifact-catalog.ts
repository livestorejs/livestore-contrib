import type { ParallelOperationStep, ScenarioRunArtifact, ScenarioStep } from './model.ts'

type ParticipantProfile = 'in-process' | 'process' | 'browser'
type SyncBackend = 'mock' | 'local-sync-cf' | 'cloud-sync-cf'
type SyncFailureId = 'SF-01' | 'SF-02' | 'SF-03' | 'SF-04'

export interface ArtifactCatalogSource {
  readonly file: string
  readonly artifact: ScenarioRunArtifact
  readonly reference: boolean
}

export interface ArtifactCatalogEntry {
  readonly findingId?: SyncFailureId
  readonly file: string
  readonly label: string
  readonly scenarioId: string
  readonly sourceRevision: string
  readonly profile: ParticipantProfile
  readonly backend: SyncBackend
  readonly applicationEventCount: number
  readonly traceRecordCount: number
  readonly status: 'passed' | 'failed'
}

const syncFailureIds: Readonly<Partial<Record<string, SyncFailureId>>> = {
  'concurrent-hotel-booking': 'SF-01',
  'pending-tail-recovery': 'SF-02',
  'many-writer-convergence': 'SF-03',
  'large-payload-recovery': 'SF-04',
}

export const buildArtifactCatalog = (
  sources: ReadonlyArray<ArtifactCatalogSource>,
): { readonly version: 4; readonly entries: ReadonlyArray<ArtifactCatalogEntry> } =>
  buildArtifactCatalogFromEntries(sources.map(makeArtifactCatalogEntry))

export const buildArtifactCatalogFromEntries = (
  entries: ReadonlyArray<ArtifactCatalogEntry>,
): { readonly version: 4; readonly entries: ReadonlyArray<ArtifactCatalogEntry> } => ({
  version: 4,
  entries: entries.toSorted(
    (left, right) =>
      (left.findingId ?? 'ZZ').localeCompare(right.findingId ?? 'ZZ') ||
      left.scenarioId.localeCompare(right.scenarioId) ||
      left.file.localeCompare(right.file),
  ),
})

export const makeArtifactCatalogEntry = ({
  file,
  artifact,
  reference,
}: ArtifactCatalogSource): ArtifactCatalogEntry => {
  const profile = artifact.descriptor.execution.participantProfile
  const backend = artifact.descriptor.execution.syncBackend
  return {
    findingId: syncFailureIds[artifact.descriptor.scenarioId],
    file,
    label: makeArtifactLabel({ artifact, profile, backend, reference }),
    scenarioId: artifact.descriptor.scenarioId,
    sourceRevision: artifact.descriptor.sourceRevision,
    profile,
    backend,
    applicationEventCount: artifact.trace.filter((record) => record.payload._tag === 'action.completed').length,
    traceRecordCount: artifact.trace.length,
    status: artifact.status,
  }
}

const makeArtifactLabel = ({
  artifact,
  profile,
  backend,
  reference,
}: {
  readonly artifact: ScenarioRunArtifact
  readonly profile: ParticipantProfile
  readonly backend: SyncBackend
  readonly reference: boolean
}): string => {
  const operations: Array<ScenarioStep | ParallelOperationStep> = []
  for (const { steps } of artifact.scenario.phases) {
    for (const step of steps) {
      if (step._tag === 'parallel') operations.push(...step.operations)
      else operations.push(step)
    }
  }
  const workloadCounts = operations.flatMap((step) => (step._tag === 'workload' ? [step.count] : []))
  const largestPayloadBytes = Math.max(
    0,
    ...operations.flatMap((step) => (step._tag === 'action' ? [largestStringLength(step.input)] : [])),
  )
  const dimensions = [
    ...(largestPayloadBytes >= 1_024 ? [`${largestPayloadBytes}-bytes`] : []),
    ...workloadCounts.map((count) => `${count}-workload`),
  ]
  return [artifact.descriptor.scenarioId, profile, backend, ...dimensions, reference === true ? 'reference' : undefined]
    .filter((part): part is string => part !== undefined)
    .join(' · ')
}

const largestStringLength = (value: unknown): number => {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value) === true) return Math.max(0, ...value.map(largestStringLength))
  if (value !== null && typeof value === 'object') return Math.max(0, ...Object.values(value).map(largestStringLength))
  return 0
}
