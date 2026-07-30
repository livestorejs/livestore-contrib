/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Viewer callbacks carry semantic IDs and reducer actions; scene derivation is memoized separately. */
import { useEffect, useState } from 'react'

import type { ScenarioRunArtifact } from '../model.ts'
import { projectTraceAt, summarizeTraceRecord } from '../projection.ts'
import {
  fetchArtifactCatalog,
  fetchArtifactJson,
  readArtifactFile,
  decodeArtifactJson,
  type ArtifactCatalog,
} from './artifact-io.ts'
import { PlaybackToolbar } from './components/PlaybackToolbar.tsx'
import { StatusBadge, type StatusTone } from './components/Primitives.tsx'
import { ScenarioTimeline } from './components/ScenarioTimeline.tsx'
import { SystemTopology } from './components/SystemTopology.tsx'
import { Tooltip } from './components/Tooltip.tsx'
import { TraceInspector } from './components/TraceInspector.tsx'
import { ArtifactPicker, ViewerHeader } from './components/ViewerHeader.tsx'
import { useScenarioViewer, type ScenarioViewerInitialState } from './useScenarioViewer.ts'

export interface ScenarioViewerAppProps {
  readonly initialArtifact?: ScenarioRunArtifact
  readonly initialState?: ScenarioViewerInitialState
  readonly hidePicker?: boolean
}

export const ScenarioViewerApp = ({ initialArtifact, initialState, hidePicker = false }: ScenarioViewerAppProps) => {
  const viewer = useScenarioViewer(initialArtifact, initialState)
  const { state, dispatch } = viewer
  const [catalog, setCatalog] = useState<ArtifactCatalog>()
  const [catalogError, setCatalogError] = useState<string>()
  const [selectedFile, setSelectedFile] = useState('')

  useEffect(() => {
    if (hidePicker === true) return
    void fetchArtifactCatalog()
      .then(setCatalog)
      .catch((cause: unknown) => setCatalogError(errorMessage(cause)))
  }, [hidePicker])

  const loadText = (textPromise: Promise<string>): void => {
    void textPromise
      .then(decodeArtifactJson)
      .then((artifact) => dispatch({ type: 'load', artifact }))
      .catch((cause: unknown) => dispatch({ type: 'load-error', message: errorMessage(cause) }))
  }
  const artifact = state.artifact
  const projected =
    artifact === undefined
      ? undefined
      : projectTraceAt({ scenario: artifact.scenario, trace: artifact.trace, cursorIndex: state.cursorIndex })
  const recordLabel = viewer.selectedMoment?.label ?? viewer.selectedRecord?.payload._tag ?? 'No observation applied'
  const runStatus = state.loadError === undefined ? (projected?.runStatus ?? 'Not loaded') : 'Load failed'
  const statusTone = statusToneFor(runStatus)

  return (
    <main className="shell">
      <ViewerHeader
        title={artifact?.descriptor.scenarioId ?? 'scenario'}
        summary={
          state.loadError ??
          (artifact === undefined
            ? 'Load a completed run artifact to begin.'
            : `${artifact.scenario.description} · seed ${artifact.descriptor.seed}`)
        }
      >
        {hidePicker === true ? null : (
          <ArtifactPicker
            catalog={catalog}
            catalogError={catalogError}
            selectedFile={selectedFile}
            onSelectedFileChange={setSelectedFile}
            onFile={(file) => loadText(readArtifactFile(file))}
            onLoad={() => loadText(fetchArtifactJson(selectedFile))}
          />
        )}
      </ViewerHeader>

      <section aria-labelledby="system-state-heading">
        <div className="section-heading">
          <h2 id="system-state-heading">System</h2>
          <StatusBadge tone={statusTone}>{runStatus}</StatusBadge>
        </div>
        {projected === undefined ? (
          <div className="empty-state">Choose an artifact above.</div>
        ) : (
          <SystemTopology
            state={projected}
            selectedEventRef={state.selectedEventRef}
            scrollStates={viewer.eventlogScrollStates}
            onSelectEvent={(eventRef) => dispatch({ type: 'event', eventRef })}
          />
        )}
      </section>

      <PlaybackToolbar
        disabled={artifact === undefined}
        playing={state.playing}
        playbackMode={state.playbackMode}
        traceVisibility={state.traceVisibility}
        timelineMode={state.timelineMode}
        timeScaleMode={state.timeScaleMode}
        cursorLabel={viewer.cursorLabel}
        onTogglePlayback={() => dispatch({ type: 'playing', playing: !state.playing })}
        onPlaybackMode={(mode) => dispatch({ type: 'playback-mode', mode })}
        onTraceVisibility={(visibility) => dispatch({ type: 'visibility', visibility })}
        onTimelineMode={(mode) => dispatch({ type: 'timeline-mode', mode })}
        onTimeScaleMode={(mode) => dispatch({ type: 'time-scale', mode })}
      />

      <section aria-labelledby="timeline-heading">
        <div className="section-heading timeline-heading">
          <div className="timeline-heading-copy">
            <h2 id="timeline-heading">Timeline</h2>
            <Tooltip content={{ title: artifact?.descriptor.runId ?? 'No trace loaded' }}>
              <p className="trace-name" tabIndex={0}>
                {artifact?.descriptor.runId ?? 'No trace loaded'}
              </p>
            </Tooltip>
          </div>
          <span id="record-label">{recordLabel}</span>
        </div>
        {artifact === undefined ? (
          <div className="timeline empty-state">No trace loaded.</div>
        ) : (
          <ScenarioTimeline
            artifact={artifact}
            cursorIndex={state.cursorIndex}
            cursorIndexes={viewer.cursorIndexes}
            recordLabel={recordLabel}
            selectedEventRef={state.selectedEventRef}
            timelineMode={state.timelineMode}
            timeScaleMode={state.timeScaleMode}
            traceVisibility={state.traceVisibility}
            viewport={state.viewport}
            onCursor={(cursorIndex) => dispatch({ type: 'cursor', cursorIndex })}
            onEvent={(eventRef) => dispatch({ type: 'event', eventRef })}
            onViewport={(viewport) => dispatch({ type: 'viewport', viewport })}
          />
        )}
      </section>

      <section className="details" aria-labelledby="details-heading">
        <div className="section-heading">
          <h2 id="details-heading">Trace</h2>
        </div>
        {artifact === undefined || viewer.selectedDetailRecordIndex === undefined ? (
          <div className="trace-inspector-empty">No trace record selected.</div>
        ) : (
          <TraceInspector
            trace={artifact.trace}
            selectedMoment={viewer.selectedMoment}
            recordIndexes={viewer.detailRecordIndexes}
            selectedRecordIndex={viewer.selectedDetailRecordIndex}
            expansion={state.expansion}
            onSelectRecord={(recordIndex) => dispatch({ type: 'detail-record', recordIndex })}
            onSectionToggle={(section, open) => dispatch({ type: 'section', section, open })}
            onJsonToggle={(record, path, open) => dispatch({ type: 'json', record, path, open })}
          />
        )}
      </section>
    </main>
  )
}

const statusToneFor = (status: string): StatusTone => {
  if (status === 'passed') return 'good'
  if (status === 'failed' || status === 'Load failed') return 'bad'
  if (status === 'running') return 'warn'
  return 'neutral'
}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
