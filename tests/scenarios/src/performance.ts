import type { FrameTiming, ScenarioRunArtifact } from './model.ts'

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

/** One 60 Hz frame; gaps beyond it are time the page could not paint. */
const FRAME_BUDGET_MS = 1000 / 60
/** Frames at least this long are long frames in the RAIL sense. */
const LONG_FRAME_MS = 50

/** Main-thread frame metrics over a run's measurement windows, summed over all participants. */
export interface FrameMetrics {
  /** Measurement time covered by the windows. */
  readonly windowMs: number
  /** Longest single frame. */
  readonly maxFrameMs: number
  /** Frames of 50 ms or longer. */
  readonly longFrames: number
  /** 60 Hz frames that could not be shown: `round(gap / 16.7) - 1` per slow frame. */
  readonly droppedFrames: number
  /** Time beyond the 16.7 ms frame budget, summed over slow frames. */
  readonly jankMs: number
  /** Blocking time Chromium attributes to long animation frames. */
  readonly longAnimationFrameBlockingMs: number
}

export interface RunFrameMetrics {
  /** Every frame in the windows. */
  readonly all: FrameMetrics
  /** Frames that did not overlap harness work which runs code in the page (observations, actions, inspections). */
  readonly excludingHarness: FrameMetrics
  /** Slow frames removed from `excludingHarness`. */
  readonly harnessAffectedFrames: number
}

/**
 * Harness calls that run noticeable code on the page's main thread. `set-connectivity` only flips a flag and polls
 * the sync latch, so frames during it belong to the application.
 */
const harnessWorkLabels = new Set(['observe', 'dispatch-action', 'inspect-state', 'capture-diagnostics'])

/**
 * Derives frame metrics from `frame.timing.observed` records over the run's measurement windows: each wait together
 * with the instruction right before it, which is the one that started the load the wait lets play out (for example a
 * reconnect followed by a quiet period). Without waits, the window is the whole workload.
 */
export const deriveFrameMetrics = (artifact: ScenarioRunArtifact): RunFrameMetrics | undefined => {
  const trace = artifact.trace
  const frameRecords = trace.filter((record) => record.payload._tag === 'frame.timing.observed')
  if (frameRecords.length === 0) return undefined
  const windows = measurementWindows(trace)
  const inWindow = (start: number) => windows.some(([from, to]) => start >= from && start < to)

  const byParticipant = new Map<string, Array<{ anchor: number; timing: FrameTiming }>>()
  for (const record of frameRecords) {
    if (record.payload._tag !== 'frame.timing.observed') continue
    // The page reported times relative to its clock reading; the midpoint of the calibrated round trip places it.
    const calibrated = record.calibratedTime
    const anchor =
      calibrated === null ? record.coordinatorReceiptMonotonicMs : (calibrated.earliestMs + calibrated.latestMs) / 2
    const key = `${record.clientId}/${record.sessionId}`
    byParticipant.set(key, [...(byParticipant.get(key) ?? []), { anchor, timing: record.payload.timing }])
  }

  const all = makeFrameAccumulator()
  const excludingHarness = makeFrameAccumulator()
  let harnessAffectedFrames = 0
  for (const reports of byParticipant.values()) {
    const harness = reports.flatMap(({ anchor, timing }) =>
      timing.harnessIntervals
        .filter(([, , label]) => harnessWorkLabels.has(label))
        .map(([start, duration]) => [anchor + start, anchor + start + duration] as const),
    )
    const affected = (start: number, end: number) => harness.some(([from, to]) => start < to && end > from)
    for (const { anchor, timing } of reports) {
      for (const [relativeStart, gap] of timing.slowFrames) {
        const start = anchor + relativeStart
        if (inWindow(start) === false) continue
        all.addFrame(gap)
        if (affected(start, start + gap) === true) harnessAffectedFrames += 1
        else excludingHarness.addFrame(gap)
      }
      for (const [relativeStart, duration, blocking] of timing.longAnimationFrames) {
        const start = anchor + relativeStart
        if (inWindow(start) === false) continue
        all.addBlocking(blocking)
        if (affected(start, start + duration) === false) excludingHarness.addBlocking(blocking)
      }
    }
  }
  const windowMs = windows.reduce((sum, [from, to]) => sum + (to - from), 0)
  return { all: all.result(windowMs), excludingHarness: excludingHarness.result(windowMs), harnessAffectedFrames }
}

const makeFrameAccumulator = () => {
  let maxFrameMs = 0
  let longFrames = 0
  let droppedFrames = 0
  let jankMs = 0
  let longAnimationFrameBlockingMs = 0
  return {
    addFrame: (gap: number) => {
      maxFrameMs = Math.max(maxFrameMs, gap)
      if (gap >= LONG_FRAME_MS) longFrames += 1
      droppedFrames += Math.max(0, Math.round(gap / FRAME_BUDGET_MS) - 1)
      jankMs += Math.max(0, gap - FRAME_BUDGET_MS)
    },
    addBlocking: (blocking: number) => {
      longAnimationFrameBlockingMs += blocking
    },
    result: (windowMs: number): FrameMetrics => ({
      windowMs,
      maxFrameMs,
      longFrames,
      droppedFrames,
      jankMs,
      longAnimationFrameBlockingMs,
    }),
  }
}

/** Each wait plus the instruction before it, in coordinator time; the workload when a Scenario has no waits. */
const measurementWindows = (trace: ScenarioRunArtifact['trace']): ReadonlyArray<readonly [number, number]> => {
  const windows: Array<readonly [number, number]> = []
  let previousInstructionStart: number | undefined
  let waitStart: number | undefined
  let waitId: string | null = null
  for (const record of trace) {
    if (record.payload._tag === 'wait.requested') {
      waitStart = previousInstructionStart ?? record.coordinatorReceiptMonotonicMs
      waitId = record.correlationId
    } else if (record.payload._tag === 'wait.completed' && record.correlationId === waitId && waitStart !== undefined) {
      windows.push([waitStart, record.coordinatorReceiptMonotonicMs])
      waitStart = undefined
    }
    if (record.origin === 'instruction') previousInstructionStart = record.coordinatorReceiptMonotonicMs
  }
  if (windows.length > 0) return windows
  const start = trace.find((record) => record.payload._tag === 'action.requested')?.coordinatorReceiptMonotonicMs
  const end = trace.find(
    (record) => record.payload._tag === 'terminal-stabilization.completed',
  )?.coordinatorReceiptMonotonicMs
  return start === undefined || end === undefined ? [] : [[start, end]]
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
