import type { ComponentSyncObservation, ScenarioTraceRecord } from '../model.ts'

export interface LeaderStateSource {
  readonly runId: string
  readonly applicationId: string
  readonly clientId: string
  readonly recordIndex: number
  readonly captureId: string | null
  readonly observation: ComponentSyncObservation
}

export interface ReconstructedTable {
  readonly name: string
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<Readonly<Record<string, ReconstructedValue>>>
}

export type ReconstructedValue = null | boolean | number | string | { readonly bytesHex: string }

export interface ReconstructedLeaderState {
  readonly source: LeaderStateSource
  readonly tables: ReadonlyArray<ReconstructedTable>
}

/** Selects one component-scoped sample; it does not infer a historical or distributed snapshot. */
export const selectLeaderStateSource = (args: {
  applicationId: string
  clientId: string
  cursorIndex: number
  trace: ReadonlyArray<ScenarioTraceRecord>
}): LeaderStateSource | undefined => {
  let selected: ScenarioTraceRecord | undefined
  for (const record of args.trace) {
    if (record.index > args.cursorIndex) break
    if (record.clientId === args.clientId && record.payload._tag === 'leader.sync.observed') {
      selected = record
    }
  }
  if (selected === undefined || selected.payload._tag !== 'leader.sync.observed') return undefined
  return {
    runId: selected.runId,
    applicationId: args.applicationId,
    clientId: args.clientId,
    recordIndex: selected.index,
    captureId: selected.captureId,
    observation: selected.payload.observation,
  }
}

export const leaderStateCacheKey = (source: LeaderStateSource): string =>
  `${source.runId}\u0000${source.applicationId}\u0000${source.clientId}\u0000${source.recordIndex}`
