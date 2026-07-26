import { useEffect, useMemo, useReducer, useRef } from 'react'

import type { ScenarioRunArtifact, ScenarioTraceRecord } from '../model.ts'
import { derivePlaybackMoments } from '../projection.ts'
import {
  clampTimelineViewport,
  type TimelineMode,
  type TimelineViewport,
  type TimeScaleMode,
  type TraceVisibility,
} from '../viewer/timeline-scene.ts'
import type { EventLogScrollState } from './components/SystemTopology.tsx'
import type { InspectorExpansionState } from './components/TraceInspector.tsx'

export type PlaybackMode = 'moments' | 'records'

export interface ScenarioViewerState {
  readonly artifact?: ScenarioRunArtifact
  readonly loadError?: string
  readonly cursorIndex: number
  readonly selectedDetailRecordIndex?: number
  readonly selectedEventRef?: string
  readonly playing: boolean
  readonly timelineMode: TimelineMode
  readonly timeScaleMode: TimeScaleMode
  readonly traceVisibility: TraceVisibility
  readonly playbackMode: PlaybackMode
  readonly viewport: TimelineViewport
  readonly expansion: InspectorExpansionState
}

export type ScenarioViewerInitialState = Partial<
  Pick<
    ScenarioViewerState,
    'cursorIndex' | 'timelineMode' | 'timeScaleMode' | 'traceVisibility' | 'playbackMode' | 'viewport'
  >
>

type Action =
  | { readonly type: 'load'; readonly artifact: ScenarioRunArtifact; readonly initial?: ScenarioViewerInitialState }
  | { readonly type: 'load-error'; readonly message: string }
  | { readonly type: 'cursor'; readonly cursorIndex: number }
  | { readonly type: 'playback-cursor'; readonly cursorIndex: number }
  | { readonly type: 'event'; readonly eventRef?: string }
  | { readonly type: 'detail-record'; readonly recordIndex: number }
  | { readonly type: 'playing'; readonly playing: boolean }
  | { readonly type: 'timeline-mode'; readonly mode: TimelineMode }
  | { readonly type: 'time-scale'; readonly mode: TimeScaleMode }
  | { readonly type: 'visibility'; readonly visibility: TraceVisibility }
  | { readonly type: 'playback-mode'; readonly mode: PlaybackMode }
  | { readonly type: 'viewport'; readonly viewport: TimelineViewport }
  | { readonly type: 'section'; readonly section: 'traceMetadataOpen' | 'rawJsonOpen'; readonly open: boolean }
  | { readonly type: 'json'; readonly record: ScenarioTraceRecord; readonly path: string; readonly open: boolean }

const initialExpansion: InspectorExpansionState = {
  traceMetadataOpen: false,
  rawJsonOpen: false,
  jsonBranchesByRecord: new Map(),
}

const initialState: ScenarioViewerState = {
  cursorIndex: -1,
  playing: false,
  timelineMode: 'flow',
  timeScaleMode: 'fit',
  traceVisibility: 'system',
  playbackMode: 'moments',
  viewport: { start: 0, end: 1 },
  expansion: initialExpansion,
}

export const useScenarioViewer = (artifact?: ScenarioRunArtifact, initial?: ScenarioViewerInitialState) => {
  const [state, dispatch] = useReducer(reducer, initialState)
  const eventlogScrollStates = useRef(new Map<string, EventLogScrollState>())
  useEffect(() => {
    if (artifact !== undefined) dispatch({ type: 'load', artifact, initial })
  }, [artifact, initial])

  const playbackMoments = useMemo(
    () =>
      state.artifact === undefined
        ? []
        : derivePlaybackMoments({ scenario: state.artifact.scenario, trace: state.artifact.trace }),
    [state.artifact],
  )
  const cursorIndexes = useMemo(() => {
    if (state.artifact === undefined) return []
    return state.playbackMode === 'moments' && playbackMoments.length > 0
      ? playbackMoments.map((moment) => moment.recordIndex)
      : state.artifact.trace.map((record) => record.index)
  }, [playbackMoments, state.artifact, state.playbackMode])

  useEffect(() => {
    if (state.playing === false) return
    const timer = window.setInterval(() => {
      const nextCursor = cursorIndexes.find((index) => index > state.cursorIndex)
      if (nextCursor === undefined) dispatch({ type: 'playing', playing: false })
      else dispatch({ type: 'playback-cursor', cursorIndex: nextCursor })
    }, 180)
    return () => window.clearInterval(timer)
  }, [cursorIndexes, state.cursorIndex, state.playing])

  const selectedMoment =
    state.playbackMode === 'moments'
      ? playbackMoments.find((moment) => moment.recordIndex === state.cursorIndex)
      : undefined
  const selectedRecord = state.cursorIndex < 0 ? undefined : state.artifact?.trace[state.cursorIndex]
  const detailRecordIndexes =
    selectedMoment?.recordIndexes ?? (selectedRecord === undefined ? [] : [selectedRecord.index])
  const selectedDetailRecordIndex =
    state.selectedDetailRecordIndex !== undefined &&
    detailRecordIndexes.includes(state.selectedDetailRecordIndex) === true
      ? state.selectedDetailRecordIndex
      : detailRecordIndexes.at(-1)
  const momentPosition = playbackMoments.findLastIndex((moment) => moment.recordIndex <= state.cursorIndex) + 1
  const recordPosition = state.cursorIndex < 0 ? 0 : state.cursorIndex + 1

  return {
    state,
    playbackMoments,
    cursorIndexes,
    selectedMoment,
    selectedRecord,
    detailRecordIndexes,
    selectedDetailRecordIndex,
    eventlogScrollStates: eventlogScrollStates.current,
    cursorLabel:
      state.playbackMode === 'moments'
        ? `${momentPosition} / ${playbackMoments.length} moments · ${recordPosition} / ${state.artifact?.trace.length ?? 0} records`
        : `${recordPosition} / ${state.artifact?.trace.length ?? 0} records`,
    dispatch,
  }
}

const reducer = (state: ScenarioViewerState, action: Action): ScenarioViewerState => {
  switch (action.type) {
    case 'load':
      return {
        ...initialState,
        ...action.initial,
        artifact: action.artifact,
        cursorIndex: action.initial?.cursorIndex ?? action.artifact.trace.length - 1,
        viewport: action.initial?.viewport ?? initialState.viewport,
        expansion: initialExpansion,
      }
    case 'load-error':
      return { ...state, loadError: action.message, playing: false }
    case 'cursor':
      return { ...state, cursorIndex: action.cursorIndex, playing: false }
    case 'playback-cursor':
      return { ...state, cursorIndex: action.cursorIndex }
    case 'event':
      return { ...state, selectedEventRef: action.eventRef }
    case 'detail-record':
      return { ...state, selectedDetailRecordIndex: action.recordIndex }
    case 'playing': {
      const last = state.artifact === undefined ? -1 : state.artifact.trace.length - 1
      return {
        ...state,
        playing: action.playing,
        cursorIndex: action.playing === true && state.cursorIndex >= last ? -1 : state.cursorIndex,
      }
    }
    case 'timeline-mode':
      return { ...state, timelineMode: action.mode, viewport: { start: 0, end: 1 } }
    case 'time-scale':
      return { ...state, timeScaleMode: action.mode, viewport: { start: 0, end: 1 } }
    case 'visibility':
      return { ...state, traceVisibility: action.visibility }
    case 'playback-mode':
      return { ...state, playbackMode: action.mode, playing: false }
    case 'viewport':
      return { ...state, viewport: clampTimelineViewport(action.viewport.start, action.viewport.end) }
    case 'section':
      return { ...state, expansion: { ...state.expansion, [action.section]: action.open } }
    case 'json': {
      const key = `${action.record.runId}:${action.record.index}`
      const branches = new Set(state.expansion.jsonBranchesByRecord.get(key) ?? ['record'])
      if (action.open === true) branches.add(action.path)
      else branches.delete(action.path)
      const jsonBranchesByRecord = new Map(state.expansion.jsonBranchesByRecord)
      jsonBranchesByRecord.set(key, branches)
      return { ...state, expansion: { ...state.expansion, jsonBranchesByRecord } }
    }
  }
}
