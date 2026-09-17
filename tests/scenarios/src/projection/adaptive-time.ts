import type { AdaptiveTimeLayout } from './types.ts'

/**
 * Preserves short elapsed-time distances while capping the visual width of long gaps.
 * Every distortion remains available as an explicit gap annotation.
 */
export const deriveAdaptiveTimeLayout = (
  timesMs: ReadonlyArray<number>,
  options?: { readonly compressionThresholdMs?: number; readonly compressedGapWidthMs?: number },
): AdaptiveTimeLayout => {
  const compressionThresholdMs = options?.compressionThresholdMs ?? 500
  const compressedGapWidthMs = options?.compressedGapWidthMs ?? 40
  const times = [...new Set(timesMs)].toSorted((left, right) => left - right)
  if (times.length === 0) return { points: [], compressedGaps: [] }
  if (times.length === 1) return { points: [{ timeMs: times[0]!, position: 0 }], compressedGaps: [] }

  const displayOffsets = [0]
  const compressedIndexes = new Set<number>()
  for (let index = 1; index < times.length; index += 1) {
    const durationMs = times[index]! - times[index - 1]!
    const compressed = durationMs > compressionThresholdMs
    if (compressed === true) compressedIndexes.add(index)
    displayOffsets.push(displayOffsets[index - 1]! + (compressed === true ? compressedGapWidthMs : durationMs))
  }
  const displayDuration = displayOffsets.at(-1) ?? 1
  const points = times.map((timeMs, index) => ({
    timeMs,
    position: displayDuration === 0 ? 0 : displayOffsets[index]! / displayDuration,
  }))
  const compressedGaps = [...compressedIndexes].map((index) => ({
    startMs: times[index - 1]!,
    endMs: times[index]!,
    durationMs: times[index]! - times[index - 1]!,
    startPosition: points[index - 1]!.position,
    endPosition: points[index]!.position,
  }))
  return { points, compressedGaps }
}

/** Maps any timestamp through an adaptive layout, including uncertainty-interval endpoints. */
export const projectAdaptiveTime = (layout: AdaptiveTimeLayout, timeMs: number): number => {
  if (layout.points.length === 0) return 0
  const first = layout.points[0]!
  if (timeMs <= first.timeMs) return first.position
  const last = layout.points.at(-1)!
  if (timeMs >= last.timeMs) return last.position

  for (let index = 1; index < layout.points.length; index += 1) {
    const right = layout.points[index]!
    if (timeMs > right.timeMs) continue
    const left = layout.points[index - 1]!
    const ratio = (timeMs - left.timeMs) / (right.timeMs - left.timeMs)
    return left.position + ratio * (right.position - left.position)
  }
  return last.position
}
