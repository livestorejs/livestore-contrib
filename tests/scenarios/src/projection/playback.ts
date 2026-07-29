import { Schema } from '@livestore/utils/effect'

import type { ScenarioAst, ScenarioTraceRecord } from '../model.ts'
import {
  applyTraceRecord,
  initialObservedSystemState,
  materialSystemSignature,
  observationComponent,
  semanticMomentKind,
  summarizeMaterialSystemChange,
  summarizeTraceRecord,
} from './system-state.ts'
import { ObservedSystemState, type EventTimelineMarker, type PlaybackMoment, type TraceCapture } from './types.ts'

/** Reduces the authoritative trace prefix into the runner's accumulated observed state. */
export const projectTraceAt = (args: {
  scenario: ScenarioAst
  trace: ReadonlyArray<ScenarioTraceRecord>
  cursorIndex: number
}): ObservedSystemState => {
  const cursorIndex = Math.min(Math.max(args.cursorIndex, -1), args.trace.length - 1)
  let state = initialObservedSystemState(args.scenario, cursorIndex)

  for (const record of args.trace.slice(0, cursorIndex + 1)) {
    state = applyTraceRecord(state, record, args.scenario)
  }

  return Schema.decodeUnknownSync(ObservedSystemState)(state)
}

/** Derives material navigation points while retaining a raw observation-index boundary for every moment. */
export const derivePlaybackMoments = (args: {
  scenario: ScenarioAst
  trace: ReadonlyArray<ScenarioTraceRecord>
}): ReadonlyArray<PlaybackMoment> => {
  const captures = deriveTraceCaptures(args.trace)
  const captureByLastRecord = new Map(captures.map((capture) => [capture.lastRecordIndex, capture]))
  const moments: Omit<PlaybackMoment, 'momentIndex'>[] = []
  let state = initialObservedSystemState(args.scenario, -1)
  let materialState = state
  let materialSignature = materialSystemSignature(state)

  for (const record of args.trace) {
    state = applyTraceRecord({ ...state, cursorIndex: record.index }, record, args.scenario)
    const kind = semanticMomentKind(record)
    if (kind !== undefined) {
      moments.push({
        recordIndex: record.index,
        recordIndexes: [record.index],
        captureId: null,
        kind,
        label: record.payload._tag,
        summary: summarizeTraceRecord(record),
      })
      materialState = state
      materialSignature = materialSystemSignature(state)
      continue
    }

    const capture = captureByLastRecord.get(record.index)
    if (capture === undefined) continue
    const nextSignature = materialSystemSignature(state)
    if (nextSignature === materialSignature) continue
    moments.push({
      recordIndex: capture.lastRecordIndex,
      recordIndexes: capture.recordIndexes,
      captureId: capture.captureId,
      kind: 'capture',
      label: `capture ${capture.captureIndex + 1} · ${capture.recordIndexes.length} records`,
      summary: summarizeMaterialSystemChange(materialState, state),
    })
    materialState = state
    materialSignature = nextSignature
  }

  return moments.map((moment, momentIndex) => ({ ...moment, momentIndex }))
}

/** Emits a marker only when one event's observed component position or disposition changes. */
export const deriveEventTimeline = (trace: ReadonlyArray<ScenarioTraceRecord>): ReadonlyArray<EventTimelineMarker> => {
  const previous = new Map<string, string>()
  const markers: EventTimelineMarker[] = []
  const captureIndexes = new Map(deriveTraceCaptures(trace).map((capture) => [capture.captureId, capture.captureIndex]))

  for (const record of trace) {
    const component = observationComponent(record)
    if (component === undefined || record.captureId === null) continue
    for (const event of component.events) {
      const key = `${component.key}\u0000${event.eventRef}`
      const signature = `${event.position}\u0000${event.parentPosition}\u0000${event.disposition}`
      if (previous.get(key) === signature) continue
      previous.set(key, signature)
      markers.push({
        recordIndex: record.index,
        componentKey: component.key,
        event,
        captureId: record.captureId,
        captureIndex: captureIndexes.get(record.captureId) ?? 0,
        calibratedTime: record.calibratedTime,
      })
    }
  }

  return markers
}

/** Groups sampled facts by collection pass without treating the pass as an atomic distributed moment. */
export const deriveTraceCaptures = (trace: ReadonlyArray<ScenarioTraceRecord>): ReadonlyArray<TraceCapture> => {
  const captures = new Map<string, number[]>()
  for (const record of trace) {
    if (record.captureId === null) continue
    const indexes = captures.get(record.captureId) ?? []
    indexes.push(record.index)
    captures.set(record.captureId, indexes)
  }
  return [...captures.entries()].map(([captureId, recordIndexes], captureIndex) => ({
    captureId,
    captureIndex,
    firstRecordIndex: recordIndexes[0]!,
    lastRecordIndex: recordIndexes.at(-1)!,
    recordIndexes,
  }))
}
