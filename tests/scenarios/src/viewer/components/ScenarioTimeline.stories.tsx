import type { Meta, StoryObj } from '@storybook/react-vite'
/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Story render functions intentionally construct isolated examples. */
import { useMemo, useState } from 'react'

import type { ScenarioRunArtifact } from '../../model.ts'
import { derivePlaybackMoments } from '../../projection.ts'
import { ReferenceFixture, type ReferenceArtifactName } from '../stories/fixtures.tsx'
import type { TimelineMode, TimelineViewport, TimeScaleMode, TraceVisibility } from '../timeline-scene.ts'
import { ScenarioTimeline } from './ScenarioTimeline.tsx'

const meta = {
  title: 'Viewer/Timeline',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

interface FixtureProps {
  readonly name?: ReferenceArtifactName
  readonly traceLimit?: number
  readonly timelineMode?: TimelineMode
  readonly timeScaleMode?: TimeScaleMode
  readonly traceVisibility?: TraceVisibility
  readonly viewport?: TimelineViewport
  readonly cursor?: 'start' | 'middle' | 'end' | 'outside'
}

const TimelineFixture = ({
  name = 'reference-offline-writer-recovery-browser-failure.json.gz',
  traceLimit,
  timelineMode = 'flow',
  timeScaleMode = 'fit',
  traceVisibility = 'evidence',
  viewport: initialViewport = { start: 0, end: 1 },
  cursor = 'middle',
}: FixtureProps) => (
  <ReferenceFixture name={name}>
    {(loaded) => (
      <StatefulTimeline
        loaded={loaded}
        traceLimit={traceLimit}
        timelineMode={timelineMode}
        timeScaleMode={timeScaleMode}
        traceVisibility={traceVisibility}
        initialViewport={initialViewport}
        cursor={cursor}
      />
    )}
  </ReferenceFixture>
)

const StatefulTimeline = ({
  loaded,
  traceLimit,
  timelineMode,
  timeScaleMode,
  traceVisibility,
  initialViewport,
  cursor,
}: {
  readonly loaded: ScenarioRunArtifact
  readonly traceLimit?: number
  readonly timelineMode: TimelineMode
  readonly timeScaleMode: TimeScaleMode
  readonly traceVisibility: TraceVisibility
  readonly initialViewport: TimelineViewport
  readonly cursor: NonNullable<FixtureProps['cursor']>
}) => {
  const artifact = useMemo(
    () =>
      traceLimit === undefined
        ? loaded
        : ({ ...loaded, trace: loaded.trace.slice(0, traceLimit) } as ScenarioRunArtifact),
    [loaded, traceLimit],
  )
  const moments = useMemo(
    () => derivePlaybackMoments({ scenario: artifact.scenario, trace: artifact.trace }),
    [artifact],
  )
  const initialCursor =
    cursor === 'start'
      ? 0
      : cursor === 'end'
        ? artifact.trace.length - 1
        : cursor === 'outside'
          ? 3
          : Math.floor(artifact.trace.length / 2)
  const [cursorIndex, setCursor] = useState(initialCursor)
  const [viewport, setViewport] = useState(initialViewport)
  const [selectedEventRef, setSelectedEventRef] = useState<string>()
  return (
    <ScenarioTimeline
      artifact={artifact}
      cursorIndex={cursorIndex}
      cursorIndexes={moments.map((moment) => moment.recordIndex)}
      recordLabel={artifact.trace[cursorIndex]?.payload._tag ?? 'No observation applied'}
      selectedEventRef={selectedEventRef}
      timelineMode={timelineMode}
      timeScaleMode={timeScaleMode}
      traceVisibility={traceVisibility}
      viewport={viewport}
      onCursor={setCursor}
      onEvent={setSelectedEventRef}
      onViewport={setViewport}
    />
  )
}

export const SparseLabels: Story = { render: () => <TimelineFixture traceLimit={28} /> }
export const MediumPoints: Story = { render: () => <TimelineFixture traceLimit={140} /> }
export const DensePointsAndAggregates: Story = {
  render: () => <TimelineFixture name="reference-shared-todo-workday-browser-failure.json.gz" />,
}
export const FittedTimeCompressedGaps: Story = {
  render: () => <TimelineFixture timelineMode="time" timeScaleMode="fit" />,
}
export const RawLinearTime: Story = { render: () => <TimelineFixture timelineMode="time" timeScaleMode="raw" /> }
export const OfflineIntervalsAndFailure: Story = { render: () => <TimelineFixture cursor="end" /> }
export const RuntimeAndTerminalFailure: Story = {
  render: () => <TimelineFixture name="reference-shared-todo-workday-browser-failure.json.gz" cursor="end" />,
}
export const SessionAndClientLifecycle: Story = {
  render: () => <TimelineFixture name="reference-browser-multi-session-recovery-browser.json.gz" cursor="end" />,
}
export const ManyLanes: Story = {
  render: () => <TimelineFixture name="reference-shared-todo-workday-browser-failure.json.gz" traceLimit={500} />,
}
export const RawTraceCarpet: Story = { render: () => <TimelineFixture traceVisibility="trace" /> }
export const NarrowedRange: Story = { render: () => <TimelineFixture viewport={{ start: 0.2, end: 0.52 }} /> }
export const PannedRangeCursorOutside: Story = {
  render: () => <TimelineFixture viewport={{ start: 0.62, end: 0.9 }} cursor="outside" />,
}
