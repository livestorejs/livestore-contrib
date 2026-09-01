import { Vitest, deriveAdaptiveTimeLayout, expect, projectAdaptiveTime } from '../test-support/scenario-test-kit.ts'

Vitest.describe('elapsed-time projection', () => {
  Vitest.it('compresses long gaps while preserving and exposing their real duration', () => {
    const layout = deriveAdaptiveTimeLayout([0, 50, 100, 3_100, 3_150], {
      compressionThresholdMs: 500,
      compressedGapWidthMs: 100,
    })

    expect(layout.compressedGaps).toEqual([expect.objectContaining({ startMs: 100, endMs: 3_100, durationMs: 3_000 })])
    expect(projectAdaptiveTime(layout, 50)).toBeCloseTo(0.2)
    expect(projectAdaptiveTime(layout, 3_100)).toBeCloseTo(0.8)
    expect(layout.points.map((point) => point.position)).toEqual(
      layout.points.map((point) => point.position).toSorted((left, right) => left - right),
    )
  })

  Vitest.it('keeps an entirely short time range linear', () => {
    const layout = deriveAdaptiveTimeLayout([0, 50, 100], { compressionThresholdMs: 500 })

    expect(layout.compressedGaps).toEqual([])
    expect(projectAdaptiveTime(layout, 50)).toBe(0.5)
  })
})
