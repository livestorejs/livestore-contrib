import { createElement, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'

import type { ScenarioRunArtifact } from '../../model.ts'
/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Controlled SVG handlers close over the current scene; geometry itself is memoized. */
import {
  clampTimelineViewport,
  deriveTimelineScene,
  type SvgSceneNode,
  type TimelineMode,
  type TimelineScene,
  type TimelineViewport,
  type TimeScaleMode,
  type TraceVisibility,
} from '../../viewer/timeline-scene.ts'

interface TimelineLayerProps {
  readonly nodes: ReadonlyArray<SvgSceneNode>
}

const SvgLayer = ({ nodes }: TimelineLayerProps) => <>{nodes.map(renderSvgNode)}</>
const CompressedGapLayer = SvgLayer
const ConnectivityBandLayer = SvgLayer
const FailureBoundaryLayer = SvgLayer
const LaneHierarchyLayer = SvgLayer
const LaneLayer = SvgLayer
const ParticipantMilestoneLayer = SvgLayer
const CaptureGuideLayer = SvgLayer
const EventMarkerLayer = SvgLayer
const RuntimeFailureLayer = SvgLayer
const TraceCarpetLayer = SvgLayer
const CursorLayer = SvgLayer
const DensityLayer = SvgLayer
const ConditionLayer = SvgLayer
const RangeWindow = SvgLayer

export interface ScenarioTimelineProps {
  readonly artifact: ScenarioRunArtifact
  readonly cursorIndex: number
  readonly cursorIndexes: ReadonlyArray<number>
  readonly recordLabel: string
  readonly selectedEventRef?: string
  readonly timelineMode: TimelineMode
  readonly timeScaleMode: TimeScaleMode
  readonly traceVisibility: TraceVisibility
  readonly viewport: TimelineViewport
  readonly onCursor: (recordIndex: number) => void
  readonly onEvent: (eventRef: string) => void
  readonly onViewport: (viewport: TimelineViewport) => void
}

export const ScenarioTimeline = (props: ScenarioTimelineProps) => {
  const scene = useMemo(
    () =>
      deriveTimelineScene({
        artifact: props.artifact,
        cursorIndex: props.cursorIndex,
        selectedEventRef: props.selectedEventRef,
        timelineMode: props.timelineMode,
        timeScaleMode: props.timeScaleMode,
        traceVisibility: props.traceVisibility,
        viewport: props.viewport,
      }),
    [
      props.artifact,
      props.cursorIndex,
      props.selectedEventRef,
      props.timelineMode,
      props.timeScaleMode,
      props.traceVisibility,
      props.viewport,
    ],
  )
  return (
    <div className="timeline">
      <MainTimelineSvg {...props} scene={scene} />
      <RangeNavigatorSvg {...props} scene={scene} />
    </div>
  )
}

type InteractiveTimelineProps = ScenarioTimelineProps & { readonly scene: TimelineScene }

interface MainDrag {
  readonly pointerId: number
  readonly startX: number
  readonly bounds: DOMRect
  readonly eventRef?: string
  readonly recordIndex?: number
  scrubbing: boolean
}

const MainTimelineSvg = ({ scene, ...props }: InteractiveTimelineProps) => {
  const drag = useRef<MainDrag | undefined>(undefined)
  const moveCursor = (clientX: number, bounds: DOMRect): void => {
    if (scene.scrubPositions.length === 0) return
    const svgX = ((clientX - bounds.left) / bounds.width) * scene.main.width
    const closest = scene.scrubPositions.reduce((candidate, position) =>
      Math.abs(position.x - svgX) < Math.abs(candidate.x - svgX) ? position : candidate,
    )
    if (closest.index !== props.cursorIndex) props.onCursor(closest.index)
  }
  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    event.preventDefault()
    const target = event.target instanceof Element ? event.target : undefined
    const eventTarget = target?.closest<SVGElement>('[data-event-ref]')
    const recordTarget = target?.closest<SVGElement>('[data-record-index]')
    const startsOnMarker =
      (eventTarget !== null && eventTarget !== undefined) || (recordTarget !== null && recordTarget !== undefined)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      bounds: event.currentTarget.getBoundingClientRect(),
      eventRef: eventTarget?.dataset.eventRef,
      recordIndex: parseRecordIndex(recordTarget?.dataset.recordIndex),
      scrubbing: startsOnMarker === false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (drag.current.scrubbing === true) moveCursor(event.clientX, drag.current.bounds)
  }
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const active = drag.current
    if (active === undefined || active.pointerId !== event.pointerId || event.buttons !== 1) return
    if (active.scrubbing === false && Math.abs(event.clientX - active.startX) >= 4) active.scrubbing = true
    if (active.scrubbing === true) moveCursor(event.clientX, active.bounds)
  }
  const handlePointerEnd = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const active = drag.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId) === true)
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (active.scrubbing === true) moveCursor(event.clientX, active.bounds)
    else if (active.eventRef !== undefined) props.onEvent(active.eventRef)
    else if (active.recordIndex !== undefined) props.onCursor(active.recordIndex)
  }
  return (
    <svg
      className="timeline-main"
      viewBox={`0 0 ${scene.main.width} ${scene.main.height}`}
      role="slider"
      tabIndex={0}
      aria-label="Trace cursor"
      aria-valuemin={0}
      aria-valuemax={props.artifact.trace.length - 1}
      aria-valuenow={Math.max(props.cursorIndex, 0)}
      aria-valuetext={props.recordLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={(event) => {
        const nextCursor =
          event.key === 'ArrowLeft'
            ? props.cursorIndexes.findLast((index) => index < props.cursorIndex)
            : event.key === 'ArrowRight'
              ? props.cursorIndexes.find((index) => index > props.cursorIndex)
              : event.key === 'Home'
                ? props.cursorIndexes[0]
                : event.key === 'End'
                  ? props.cursorIndexes.at(-1)
                  : undefined
        if (nextCursor === undefined) return
        event.preventDefault()
        props.onCursor(nextCursor)
      }}
    >
      <CompressedGapLayer nodes={scene.main.compressedGaps} />
      <ConnectivityBandLayer nodes={scene.main.connectivityBands} />
      <FailureBoundaryLayer nodes={scene.main.failureBoundaries} />
      <LaneHierarchyLayer nodes={scene.main.laneHierarchy} />
      <LaneLayer nodes={scene.main.laneLayer} />
      <ParticipantMilestoneLayer nodes={scene.main.participantMilestones} />
      <CaptureGuideLayer nodes={scene.main.captureGuides} />
      <EventMarkerLayer nodes={scene.main.eventMarkers} />
      <RuntimeFailureLayer nodes={scene.main.runtimeFailures} />
      <TraceCarpetLayer nodes={scene.main.traceCarpet} />
      <CursorLayer nodes={scene.main.cursorLayer} />
    </svg>
  )
}

interface RangeDrag {
  readonly pointerId: number
  readonly action: 'start' | 'end' | 'window'
  readonly pointerStart: number
  readonly viewportStart: number
  readonly viewportEnd: number
  readonly bounds: DOMRect
}

const RangeNavigatorSvg = ({ scene, ...props }: InteractiveTimelineProps) => {
  const drag = useRef<RangeDrag | undefined>(undefined)
  const positionAt = (clientX: number, bounds: DOMRect): number =>
    clamp((((clientX - bounds.left) / bounds.width) * scene.range.width - 180) / (scene.range.width - 180 - 35), 0, 1)
  const updateRange = (active: RangeDrag, clientX: number): void => {
    const position = positionAt(clientX, active.bounds)
    if (active.action === 'start') {
      props.onViewport(clampTimelineViewport(Math.min(position, active.viewportEnd - 0.01), active.viewportEnd))
    } else if (active.action === 'end') {
      props.onViewport(clampTimelineViewport(active.viewportStart, Math.max(position, active.viewportStart + 0.01)))
    } else {
      const delta = position - active.pointerStart
      props.onViewport(clampTimelineViewport(active.viewportStart + delta, active.viewportEnd + delta))
    }
  }
  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-range-action]') : null
    const action = target?.dataset.rangeAction
    if (action !== 'track' && action !== 'start' && action !== 'end' && action !== 'window') return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const pointerStart = positionAt(event.clientX, bounds)
    if (action === 'track') {
      const span = props.viewport.end - props.viewport.start
      props.onViewport(clampTimelineViewport(pointerStart - span / 2, pointerStart + span / 2))
      return
    }
    drag.current = {
      pointerId: event.pointerId,
      action,
      pointerStart,
      viewportStart: props.viewport.start,
      viewportEnd: props.viewport.end,
      bounds,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const active = drag.current
    if (active === undefined || active.pointerId !== event.pointerId || event.buttons !== 1) return
    updateRange(active, event.clientX)
  }
  const handlePointerEnd = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const active = drag.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId) === true)
      event.currentTarget.releasePointerCapture(event.pointerId)
    updateRange(active, event.clientX)
  }
  return (
    <svg
      className="range-navigator"
      viewBox={`0 0 ${scene.range.width} ${scene.range.height}`}
      role="group"
      tabIndex={0}
      aria-label="Timeline visible range"
      data-range-navigator
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={(event) => {
        const span = props.viewport.end - props.viewport.start
        const midpoint = (props.viewport.start + props.viewport.end) / 2
        let next: TimelineViewport | undefined
        if (event.key === 'Home' || event.key === 'Escape') next = { start: 0, end: 1 }
        else if (event.key === '+' || event.key === '=') {
          const nextSpan = span * 0.75
          next = clampTimelineViewport(midpoint - nextSpan / 2, midpoint + nextSpan / 2)
        } else if (event.key === '-') {
          const nextSpan = Math.min(span / 0.75, 1)
          next = clampTimelineViewport(midpoint - nextSpan / 2, midpoint + nextSpan / 2)
        } else if (event.key === 'ArrowLeft') {
          next = clampTimelineViewport(props.viewport.start - span * 0.1, props.viewport.end - span * 0.1)
        } else if (event.key === 'ArrowRight') {
          next = clampTimelineViewport(props.viewport.start + span * 0.1, props.viewport.end + span * 0.1)
        }
        if (next === undefined) return
        event.preventDefault()
        props.onViewport(next)
      }}
    >
      <RangeWindow nodes={scene.range.windowLayer.slice(0, 3)} />
      <DensityLayer nodes={scene.range.densityLayer} />
      <ConditionLayer nodes={scene.range.conditionLayer} />
      <FailureBoundaryLayer nodes={scene.range.failureLayer} />
      <RangeWindow nodes={scene.range.windowLayer.slice(3)} />
      <CursorLayer nodes={scene.range.cursorLayer} />
    </svg>
  )
}

const renderSvgNode = (node: SvgSceneNode, index: number): ReactElement => {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {}).map(([key, value]) => [reactSvgAttribute(key), value]),
  )
  return createElement(
    node.tag,
    { ...attrs, key: `${node.tag}:${index}` },
    node.text,
    ...(node.children ?? []).map(renderSvgNode),
  )
}

const reactSvgAttribute = (attribute: string): string => {
  if (attribute === 'class') return 'className'
  if (attribute === 'text-anchor') return 'textAnchor'
  if (attribute === 'aria-hidden') return 'aria-hidden'
  return attribute
}

const parseRecordIndex = (value: string | undefined): number | undefined => {
  const parsed = Number(value)
  return Number.isInteger(parsed) === true ? parsed : undefined
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(Math.max(value, minimum), maximum)
