import fs from 'node:fs'
import { gunzipSync } from 'node:zlib'

import { describe, expect, test } from 'vitest'

import { derivePlaybackMoments } from '../projection.ts'
import { decodeArtifactJson } from './artifact-io.ts'
import { clampTimelineViewport, deriveTimelineScene } from './timeline-scene.ts'

const decodeReference = (file: string) => {
  const data = fs.readFileSync(new URL(`../../artifacts/${file}`, import.meta.url))
  return decodeArtifactJson(gunzipSync(data).toString('utf8'))
}

const offlineArtifact = decodeReference('reference-offline-writer-recovery-browser.json.gz')
const denseArtifact = decodeReference('reference-shared-todo-workday-browser.json.gz')
const lifecycleArtifact = decodeReference('reference-browser-multi-session-recovery-browser.json.gz')
const manyWriterArtifact = decodeReference('sf-03-many-writer-426.json.gz')

describe('deriveTimelineScene', () => {
  test('keeps the established viewBox, lane hierarchy, and two-SVG geometry', () => {
    const scene = deriveTimelineScene({
      artifact: offlineArtifact,
      cursorIndex: offlineArtifact.trace.length - 1,
      timelineMode: 'flow',
      timeScaleMode: 'fit',
      traceVisibility: 'evidence',
      viewport: { start: 0, end: 1 },
    })

    expect(scene.main.width).toBe(1400)
    expect(scene.range.width).toBe(scene.main.width)
    expect(scene.range.height).toBe(44)
    expect(scene.lanes).toHaveLength(
      1 + offlineArtifact.scenario.topology.clients.reduce((count, client) => count + 1 + client.sessions.length, 0),
    )
    expect(scene.main.laneLayer).not.toHaveLength(0)
    expect(scene.scrubPositions.every(({ x }) => x >= 180 && x <= 1365)).toBe(true)
    expect(
      [...scene.tooltipContentById.values()].some((content) => content.details?.some(({ label }) => label === 'id')),
    ).toBe(true)
  })

  test('uses bounded local aggregation for the dense shared-todo trace', () => {
    const scene = deriveTimelineScene({
      artifact: denseArtifact,
      cursorIndex: denseArtifact.trace.length - 1,
      timelineMode: 'flow',
      timeScaleMode: 'fit',
      traceVisibility: 'evidence',
      viewport: { start: 0, end: 1 },
    })

    expect(['point', 'aggregate']).toContain(scene.markerMode)
    expect(scene.main.eventMarkers.length).toBeGreaterThan(0)
    expect(scene.main.eventMarkers.length).toBeLessThan(denseArtifact.trace.length)
    expect(scene.range.densityLayer.length).toBeLessThanOrEqual(160)
  })

  test('recomputes semantic detail and keeps an outside cursor only in the overview', () => {
    const narrowed = deriveTimelineScene({
      artifact: denseArtifact,
      cursorIndex: 3,
      timelineMode: 'time',
      timeScaleMode: 'fit',
      traceVisibility: 'trace',
      viewport: { start: 0.62, end: 0.9 },
    })

    expect(narrowed.mainCursorVisible).toBe(false)
    expect(narrowed.range.cursorLayer).toHaveLength(1)
    expect(narrowed.scrubPositions.every(({ x }) => x >= 180 && x <= 1365)).toBe(true)
    expect(narrowed.main.traceCarpet.length).toBeGreaterThan(1)
  })

  test('labels fitted-time distortions and retains raw-time carpet context', () => {
    const scene = deriveTimelineScene({
      artifact: offlineArtifact,
      cursorIndex: Math.floor(offlineArtifact.trace.length / 2),
      timelineMode: 'time',
      timeScaleMode: 'fit',
      traceVisibility: 'evidence',
      viewport: { start: 0, end: 1 },
    })

    expect(scene.main.traceCarpet[0]?.text).toBe('SYNC EVIDENCE · RAW TIME')
    for (const label of scene.main.compressedGaps.filter((item) => item.tag === 'text')) {
      expect(label.text).toMatch(/^\/\/ .+ \/\/$/)
    }
  })

  test('projects session and client lifecycle boundaries from a passed browser run', () => {
    const scene = deriveTimelineScene({
      artifact: lifecycleArtifact,
      cursorIndex: lifecycleArtifact.trace.length - 1,
      timelineMode: 'flow',
      timeScaleMode: 'fit',
      traceVisibility: 'evidence',
      viewport: { start: 0, end: 1 },
    })

    expect(lifecycleArtifact.status).toBe('passed')
    expect(scene.main.participantMilestones.some((item) => String(item.attrs?.class).includes('lifecycle'))).toBe(true)
    expect(scene.main.failureBoundaries).toHaveLength(0)
  })

  test('collapses the SF-03 workload and gives settlement evidence the semantic flow space', () => {
    const moments = derivePlaybackMoments({ scenario: manyWriterArtifact.scenario, trace: manyWriterArtifact.trace })
    const workloadMoments = moments.filter((moment) => moment.kind === 'workload')
    const actionMoments = moments.filter((moment) => moment.kind === 'action')
    const scene = deriveTimelineScene({
      artifact: manyWriterArtifact,
      cursorIndex: manyWriterArtifact.trace.length - 1,
      timelineMode: 'flow',
      timeScaleMode: 'fit',
      traceVisibility: 'evidence',
      viewport: { start: 0, end: 1 },
    })
    const lastWorkloadAction = manyWriterArtifact.trace.findLast(
      (record) => record.payload._tag === 'action.requested',
    )!
    const workloadRequest = manyWriterArtifact.trace.find((record) => record.payload._tag === 'workload.requested')!
    const workloadCompletion = manyWriterArtifact.trace.find((record) => record.payload._tag === 'workload.completed')!
    const firstMaterialObservation = manyWriterArtifact.trace.find(
      (record) =>
        (record.payload._tag === 'leader.sync.observed' || record.payload._tag === 'session.sync.observed') &&
        record.payload.observation.events.length > 0,
    )!
    const lastMaterialObservation = manyWriterArtifact.trace.findLast(
      (record) => record.payload._tag === 'backend.observed' && record.payload.observation.events.length > 0,
    )!

    expect(workloadMoments).toHaveLength(1)
    expect(actionMoments).toHaveLength(0)
    expect(workloadMoments[0]?.recordIndexes).toEqual([workloadRequest.index, workloadCompletion.index])
    expect(workloadMoments[0]?.summary).toContain('426 actions')
    expect(workloadMoments[0]?.summary).toContain('client-1/session-1: 226')
    expect(workloadMoments[0]?.summary).toContain('client-2/session-2: 200')
    expect(scene.normalizedRecordPositions[lastWorkloadAction.index]).toBe(
      scene.normalizedRecordPositions[workloadCompletion.index],
    )
    expect(scene.normalizedRecordPositions[firstMaterialObservation.index]).toBeGreaterThan(
      scene.normalizedRecordPositions[workloadCompletion.index]!,
    )
    expect(scene.normalizedRecordPositions[lastMaterialObservation.index]).toBeGreaterThan(
      scene.normalizedRecordPositions[firstMaterialObservation.index]!,
    )
    expect(scene.main.traceCarpet.filter((item) => String(item.attrs?.class).includes('evidence-moment')).length).toBe(
      moments.length,
    )
  })
})

describe('clampTimelineViewport', () => {
  test.each([
    [
      { start: -0.2, end: 0.3 },
      { start: 0, end: 0.5 },
    ],
    [
      { start: 0.8, end: 1.4 },
      { start: 0.4, end: 1 },
    ],
    [
      { start: 0.5, end: 0.501 },
      { start: 0.4955, end: 0.5055 },
    ],
    [
      { start: 0, end: 1 },
      { start: 0, end: 1 },
    ],
  ])('normalizes %o to %o', (input, expected) => {
    const actual = clampTimelineViewport(input.start, input.end)
    expect(actual.start).toBeCloseTo(expected.start, 10)
    expect(actual.end).toBeCloseTo(expected.end, 10)
  })
})
