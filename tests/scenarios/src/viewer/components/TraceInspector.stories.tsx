import type { Meta, StoryObj } from '@storybook/react-vite'
/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Story render functions intentionally construct isolated examples. */
import { useMemo, useState } from 'react'

import type { ScenarioTraceRecord } from '../../model.ts'
import { derivePlaybackMoments } from '../../projection.ts'
import { ReferenceFixture } from '../stories/fixtures.tsx'
import { TraceInspector, type InspectorExpansionState } from './TraceInspector.tsx'

const meta = {
  title: 'Viewer/Trace inspector',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const InspectorFixture = ({ multi, expanded }: { readonly multi: boolean; readonly expanded: boolean }) => (
  <ReferenceFixture name="reference-offline-writer-recovery-browser.json.gz">
    {(artifact) => {
      const moments = derivePlaybackMoments({ scenario: artifact.scenario, trace: artifact.trace })
      const moment = multi === true ? moments.find((candidate) => candidate.recordIndexes.length > 1) : undefined
      const recordIndexes = moment?.recordIndexes ?? [Math.min(artifact.trace.length - 1, 5)]
      return (
        <StatefulInspector trace={artifact.trace} moment={moment} recordIndexes={recordIndexes} expanded={expanded} />
      )
    }}
  </ReferenceFixture>
)

const StatefulInspector = ({
  trace,
  moment,
  recordIndexes,
  expanded,
}: {
  readonly trace: ReadonlyArray<ScenarioTraceRecord>
  readonly moment: ReturnType<typeof derivePlaybackMoments>[number] | undefined
  readonly recordIndexes: ReadonlyArray<number>
  readonly expanded: boolean
}) => {
  const [selectedRecordIndex, setSelectedRecordIndex] = useState(recordIndexes.at(-1)!)
  const [traceMetadataOpen, setTraceMetadataOpen] = useState(expanded)
  const [rawJsonOpen, setRawJsonOpen] = useState(expanded)
  const [jsonBranchesByRecord, setBranches] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => {
    const record = trace[selectedRecordIndex]!
    return new Map([[`${record.runId}:${record.index}`, new Set(['record', 'record/payload'])]])
  })
  const expansion: InspectorExpansionState = useMemo(
    () => ({ traceMetadataOpen, rawJsonOpen, jsonBranchesByRecord }),
    [jsonBranchesByRecord, rawJsonOpen, traceMetadataOpen],
  )
  return (
    <TraceInspector
      trace={trace}
      selectedMoment={moment}
      recordIndexes={recordIndexes}
      selectedRecordIndex={selectedRecordIndex}
      expansion={expansion}
      onSelectRecord={setSelectedRecordIndex}
      onSectionToggle={(section, open) =>
        section === 'traceMetadataOpen' ? setTraceMetadataOpen(open) : setRawJsonOpen(open)
      }
      onJsonToggle={(record, path, open) => {
        const key = `${record.runId}:${record.index}`
        const branches = new Set(jsonBranchesByRecord.get(key) ?? ['record'])
        if (open === true) branches.add(path)
        else branches.delete(path)
        setBranches(new Map(jsonBranchesByRecord).set(key, branches))
      }}
    />
  )
}

export const SingleRecord: Story = { render: () => <InspectorFixture multi={false} expanded={false} /> }
export const MultiRecordMoment: Story = { render: () => <InspectorFixture multi expanded={false} /> }
export const ExpandedMetadataAndJson: Story = { render: () => <InspectorFixture multi expanded /> }
