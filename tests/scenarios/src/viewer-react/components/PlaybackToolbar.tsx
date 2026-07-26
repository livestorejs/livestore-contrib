import type { TimelineMode, TimeScaleMode, TraceVisibility } from '../../viewer/timeline-scene.ts'
/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop -- Small static control option lists are clearer inline. */
import type { PlaybackMode } from '../useScenarioViewer.ts'
import { ModeControl, SegmentedControl } from './Primitives.tsx'

export const PlaybackToolbar = ({
  disabled,
  playing,
  playbackMode,
  traceVisibility,
  timelineMode,
  timeScaleMode,
  cursorLabel,
  onTogglePlayback,
  onPlaybackMode,
  onTraceVisibility,
  onTimelineMode,
  onTimeScaleMode,
}: {
  readonly disabled: boolean
  readonly playing: boolean
  readonly playbackMode: PlaybackMode
  readonly traceVisibility: TraceVisibility
  readonly timelineMode: TimelineMode
  readonly timeScaleMode: TimeScaleMode
  readonly cursorLabel: string
  readonly onTogglePlayback: () => void
  readonly onPlaybackMode: (mode: PlaybackMode) => void
  readonly onTraceVisibility: (visibility: TraceVisibility) => void
  readonly onTimelineMode: (mode: TimelineMode) => void
  readonly onTimeScaleMode: (mode: TimeScaleMode) => void
}) => (
  <nav className="timeline-actions" aria-label="Timeline playback and display controls">
    <button className="timeline-play" type="button" disabled={disabled} onClick={onTogglePlayback}>
      {playing === true ? 'pause' : 'play'}
    </button>
    <div className="timeline-action-settings">
      <ModeControl label="play">
        <SegmentedControl
          label="Playback stepping"
          value={playbackMode}
          options={[
            { value: 'moments', label: 'moments' },
            { value: 'records', label: 'records' },
          ]}
          onChange={onPlaybackMode}
        />
      </ModeControl>
      <ModeControl label="show">
        <SegmentedControl
          label="Trace visibility"
          value={traceVisibility}
          options={[
            { value: 'system', label: 'system' },
            { value: 'all', label: 'all' },
          ]}
          onChange={onTraceVisibility}
        />
      </ModeControl>
      <ModeControl label="layout">
        <SegmentedControl
          label="Timeline projection"
          value={timelineMode}
          options={[
            { value: 'flow', label: 'flow' },
            { value: 'time', label: 'time' },
          ]}
          onChange={onTimelineMode}
        />
        {timelineMode === 'time' ? (
          <SegmentedControl
            className="time-scale-switch"
            label="Time scale"
            value={timeScaleMode}
            options={[
              { value: 'fit', label: 'fit' },
              { value: 'raw', label: 'raw' },
            ]}
            onChange={onTimeScaleMode}
          />
        ) : null}
      </ModeControl>
    </div>
    <span id="cursor-label">{cursorLabel}</span>
  </nav>
)
