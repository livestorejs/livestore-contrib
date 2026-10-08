import { describe, expect, it } from 'vitest'

import { makeArtifactCatalogEntry, type ArtifactCatalogEntry } from './artifact-catalog.ts'
import type { ScenarioRunArtifact } from './model.ts'
import { deriveRunTimings, summarizeDurations } from './performance.ts'
import { compareRuns } from './run-comparison.ts'

const artifact = (status = 'passed') =>
  ({
    status,
    descriptor: {
      scenarioId: 'recovery',
      sourceRevision: 'base',
      seed: 1,
      traceVersion: 7,
      execution: { participantProfile: 'browser', syncBackend: 'local-sync-cf' },
    },
    scenario: { seed: 1, topology: { clients: [{ id: 'a' }, { id: 'b' }] }, instructions: [] },
    trace: [
      ['run.started', 10, {}],
      ['client.created', 20, {}, 'a'],
      ['client.created', 40, {}, 'b'],
      ['action.requested', 50, {}],
      ['fault.removed', 60, { faultId: 'f1' }],
      ['fault.removed', 65, { faultId: 'f2' }],
      ['recovery.completed', 100, { faultIds: ['f1', 'f2'] }],
      ['terminal-stabilization.completed', 110, {}],
      ['run.completed', 120, {}],
    ].map(([tag, time, payload, clientId]) => ({
      payload: { _tag: tag, ...(payload as object) },
      clientId: clientId ?? null,
      coordinatorReceiptMonotonicMs: time,
      localMonotonicMs: 99999,
      wallTimeMs: 0,
    })),
  }) as unknown as ScenarioRunArtifact
const entry = (
  file: string,
  revision: string,
  ms: number,
  status: 'passed' | 'failed' = 'passed',
): ArtifactCatalogEntry => ({
  file,
  label: 'recovery',
  scenarioId: 'recovery',
  profile: 'browser',
  backend: 'local-sync-cf',
  sourceRevision: revision,
  applicationEventCount: 1,
  traceRecordCount: 10,
  status,
  timings: { runMs: ms },
  comparisonKey: 'workload',
})

describe('performance summaries', () => {
  it('uses controller clocks and measures the slowest completed recovery without summing overlaps', () => {
    expect(deriveRunTimings(artifact())).toEqual({ runMs: 110, startupMs: 30, workloadMs: 60, recoveryMs: 40 })
  })
  it('does not turn an early failure into a fast result', () =>
    expect(deriveRunTimings(artifact('failed'))).toEqual({}))
  it('does not manufacture timings from missing or reversed timestamps', () => {
    const a = artifact()
    expect(
      deriveRunTimings({ ...a, trace: a.trace.map((r) => ({ ...r, coordinatorReceiptMonotonicMs: undefined! })) }),
    ).toEqual({})
    expect(
      deriveRunTimings({
        ...a,
        trace: a.trace.map((r) => ({ ...r, coordinatorReceiptMonotonicMs: -r.coordinatorReceiptMonotonicMs })),
      }).runMs,
    ).toBeUndefined()
  })
  it('reports median and range, excluding invalid durations', () =>
    expect(summarizeDurations([4, 1, 2, 100, NaN, -3])).toEqual({ count: 4, median: 3, min: 1, max: 100 }))
  it('fingerprints inputs, seed, and execution separately from source revision', () => {
    const a = artifact()
    const key = (x: ScenarioRunArtifact) =>
      makeArtifactCatalogEntry({ file: 'a', artifact: x, reference: false }).comparisonKey
    expect(key(a)).toBe(key({ ...a, descriptor: { ...a.descriptor, sourceRevision: 'new' } }))
    expect(key(a)).not.toBe(key({ ...a, scenario: { ...a.scenario, seed: 2 } }))
    expect(key(a)).not.toBe(
      key({
        ...a,
        descriptor: { ...a.descriptor, execution: { ...a.descriptor.execution, participantProfile: 'process' } },
      }),
    )
  })
  it('compares all passing samples and withholds changes when any sample fails', () => {
    const entries = [entry('a', 'base', 100), entry('b', 'base', 200), entry('c', 'new', 120)]
    expect(compareRuns(entries, 'base', 'new', 'runMs')[0]?.delta).toBeCloseTo(-20)
    expect(compareRuns([...entries, entry('d', 'new', 1, 'failed')], 'base', 'new', 'runMs')[0]?.delta).toBeUndefined()
  })
  it('never matches different workloads or old unkeyed catalogs', () => {
    expect(
      compareRuns([entry('a', 'base', 1), { ...entry('b', 'new', 2), comparisonKey: 'other' }], 'base', 'new', 'runMs'),
    ).toHaveLength(2)
    expect(
      compareRuns(
        [entry('a', 'base', 1), { ...entry('b', 'new', 2), comparisonKey: undefined }],
        'base',
        'new',
        'runMs',
      ).every((r) => r.delta === undefined),
    ).toBe(true)
  })
  it('withholds incomplete or mixed-campaign comparisons and missing metrics', () => {
    const a = {
      ...entry('a', 'base', 1),
      benchmark: { id: 'one', role: 'baseline' as const, iteration: 1, complete: false },
    }
    const b = {
      ...entry('b', 'new', 2),
      benchmark: { id: 'one', role: 'candidate' as const, iteration: 1, complete: true },
    }
    expect(compareRuns([a, b], 'base', 'new', 'runMs')[0]?.delta).toBeUndefined()
    expect(
      compareRuns([{ ...a, benchmark: { ...a.benchmark, complete: true, id: 'other' } }, b], 'base', 'new', 'runMs')[0]
        ?.delta,
    ).toBeUndefined()
    expect(
      compareRuns([entry('a', 'base', 1), entry('b', 'new', 2)], 'base', 'new', 'recoveryMs')[0]?.delta,
    ).toBeUndefined()
  })
})
