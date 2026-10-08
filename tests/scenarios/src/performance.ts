import type { ScenarioRunArtifact } from './model.ts'

/** Controller-clock durations; never subtract clocks belonging to different participants. */
export interface RunTimings {
  readonly runMs?: number
  readonly startupMs?: number
  readonly workloadMs?: number
  /** Longest completed fault-removal → recovery-confirmation interval. */
  readonly recoveryMs?: number
}
export type TimingMetric = keyof RunTimings
export const timingMetrics = [
  ['runMs', 'Time to pass'],
  ['startupMs', 'Client startup'],
  ['workloadMs', 'Writes → settled'],
  ['recoveryMs', 'Slowest recovery'],
] as const

export const deriveRunTimings = (artifact: ScenarioRunArtifact): RunTimings => {
  if (artifact.status !== 'passed') return {}
  const trace = artifact.trace
  const time = (tag: string) => trace.find((r) => r.payload._tag === tag)?.coordinatorReceiptMonotonicMs
  const span = (start: number | undefined, end: number | undefined) =>
    start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? end - start
      : undefined
  const start = time('run.started')
  const initialClients = new Set(artifact.scenario.topology.clients.map((client) => client.id))
  const created = trace.filter(
    (r) => r.payload._tag === 'client.created' && r.clientId !== null && initialClients.has(r.clientId),
  )
  const ready =
    new Set(created.map((r) => r.clientId)).size === initialClients.size && created.length > 0
      ? Math.max(...created.map((r) => r.coordinatorReceiptMonotonicMs))
      : undefined
  const removals = new Map<string, number>()
  const recovery: number[] = []
  for (const record of trace) {
    if (record.payload._tag === 'fault.removed')
      removals.set(record.payload.faultId, record.coordinatorReceiptMonotonicMs)
    if (record.payload._tag === 'recovery.completed')
      for (const id of record.payload.faultIds) {
        const elapsed = span(removals.get(id), record.coordinatorReceiptMonotonicMs)
        if (elapsed !== undefined) recovery.push(elapsed)
        removals.delete(id)
      }
  }
  return {
    runMs: span(start, time('run.completed')),
    startupMs: span(start, ready),
    workloadMs: span(time('action.requested'), time('terminal-stabilization.completed')),
    recoveryMs: recovery.length > 0 ? Math.max(...recovery) : undefined,
  }
}

export const summarizeDurations = (values: ReadonlyArray<number>) => {
  const sorted = values.filter((n) => Number.isFinite(n) && n >= 0).toSorted((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  }
}
export const formatDuration = (ms: number | undefined): string =>
  ms === undefined ? '—' : ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`
