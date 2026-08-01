import type { ObservedEvent, ScenarioRunArtifact } from '../model.ts'
import {
  backendComponentKey,
  deriveAdaptiveTimeLayout,
  deriveConnectivityIntervals,
  deriveEventTimeline,
  deriveLaneActivityIntervals,
  derivePlaybackMoments,
  deriveRuntimeFailureIntervals,
  deriveTraceCaptures,
  leaderComponentKey,
  projectAdaptiveTime,
  sessionComponentKey,
} from '../projection.ts'
import type { TooltipContent } from './components/Tooltip.tsx'
import { timelineEventTooltipContent } from './event-tooltip.ts'

export type TimelineMode = 'flow' | 'time'
export type TimeScaleMode = 'fit' | 'raw'
export type TraceVisibility = 'evidence' | 'trace'
export interface TimelineViewport {
  readonly start: number
  readonly end: number
}

export type SvgAttribute = string | number | boolean | undefined
export interface SvgSceneNode {
  readonly tag: 'circle' | 'g' | 'line' | 'path' | 'rect' | 'text'
  readonly attrs?: Readonly<Record<string, SvgAttribute>>
  readonly children?: ReadonlyArray<SvgSceneNode>
  readonly text?: string
}

export interface TimelineLaneScene {
  readonly key: string
  readonly label: string
  readonly color: string
  readonly role: 'backend' | 'leader' | 'session'
  readonly y: number
}

export interface MainTimelineScene {
  readonly width: number
  readonly height: number
  readonly carpetTop: number
  readonly compressedGaps: ReadonlyArray<SvgSceneNode>
  readonly connectivityBands: ReadonlyArray<SvgSceneNode>
  readonly failureBoundaries: ReadonlyArray<SvgSceneNode>
  readonly laneHierarchy: ReadonlyArray<SvgSceneNode>
  readonly laneLayer: ReadonlyArray<SvgSceneNode>
  readonly participantMilestones: ReadonlyArray<SvgSceneNode>
  readonly captureGuides: ReadonlyArray<SvgSceneNode>
  readonly eventMarkers: ReadonlyArray<SvgSceneNode>
  readonly runtimeFailures: ReadonlyArray<SvgSceneNode>
  readonly traceCarpet: ReadonlyArray<SvgSceneNode>
  readonly cursorLayer: ReadonlyArray<SvgSceneNode>
}

export interface RangeNavigatorScene {
  readonly width: number
  readonly height: 44
  readonly rangeSummary: string
  readonly densityLayer: ReadonlyArray<SvgSceneNode>
  readonly conditionLayer: ReadonlyArray<SvgSceneNode>
  readonly failureLayer: ReadonlyArray<SvgSceneNode>
  readonly windowLayer: ReadonlyArray<SvgSceneNode>
  readonly cursorLayer: ReadonlyArray<SvgSceneNode>
}

export interface TimelineScene {
  readonly lanes: ReadonlyArray<TimelineLaneScene>
  readonly main: MainTimelineScene
  readonly range: RangeNavigatorScene
  /** Custom tooltip content for every semantic timeline marker. */
  readonly tooltipContentById: ReadonlyMap<string, TooltipContent>
  /** Visible cursor targets after applying visibility, playback, and viewport projections. */
  readonly scrubPositions: ReadonlyArray<{ readonly index: number; readonly x: number }>
  readonly markerMode: 'label' | 'point' | 'aggregate'
  readonly normalizedRecordPositions: ReadonlyArray<number>
  readonly mainCursorVisible: boolean
}

export interface DeriveTimelineSceneArgs {
  readonly artifact: ScenarioRunArtifact
  readonly cursorIndex: number
  readonly selectedEventRef?: string
  readonly timelineMode: TimelineMode
  readonly timeScaleMode: TimeScaleMode
  readonly traceVisibility: TraceVisibility
  readonly viewport: TimelineViewport
}

type TimelineMarker = ReturnType<typeof deriveEventTimeline>[number]
type PositionedTimelineMarker = { readonly marker: TimelineMarker; readonly x: number }

const node = (
  tag: SvgSceneNode['tag'],
  attrs?: Readonly<Record<string, SvgAttribute>>,
  children?: ReadonlyArray<SvgSceneNode>,
  text?: string,
): SvgSceneNode => ({ tag, attrs, children, text })

/**
 * Derives every timeline coordinate and semantic layer without reading or mutating the DOM.
 * Keeping geometry separate from rendering makes semantic thresholds directly testable.
 */
export const deriveTimelineScene = (args: DeriveTimelineSceneArgs): TimelineScene => {
  const { artifact, cursorIndex, selectedEventRef, timelineMode, timeScaleMode, traceVisibility } = args
  const trace = artifact.trace
  const viewport = clampTimelineViewport(args.viewport.start, args.viewport.end)
  const markers = deriveEventTimeline(trace)
  const tooltipContentById = new Map<string, TooltipContent>()
  let nextTooltipId = 1
  const withTooltip = (content: TooltipContent | string, child: SvgSceneNode): SvgSceneNode => {
    const tooltipId = `timeline-tooltip-${nextTooltipId}`
    nextTooltipId += 1
    tooltipContentById.set(tooltipId, typeof content === 'string' ? { title: content } : content)
    return { ...child, attrs: { ...child.attrs, 'data-timeline-tooltip-id': tooltipId } }
  }
  const captures = deriveTraceCaptures(trace)
  const connectivityIntervals = deriveConnectivityIntervals(trace)
  const laneActivityIntervals = deriveLaneActivityIntervals({ scenario: artifact.scenario, trace })
  const runtimeFailureIntervals = deriveRuntimeFailureIntervals(trace)
  const playbackMoments = derivePlaybackMoments({ scenario: artifact.scenario, trace })
  const clientsById = new Map(artifact.scenario.topology.clients.map((client) => [client.id, client]))
  const clientColorsById = new Map(
    artifact.scenario.topology.clients.map((client, index) => [client.id, clientColor(index)]),
  )
  const evidenceCaptureIds = new Set(
    playbackMoments.flatMap((moment) => (moment.captureId === null ? [] : [moment.captureId])),
  )
  const lanes: ReadonlyArray<TimelineLaneScene> = [
    { key: backendComponentKey, label: 'Backend', color: '#4169e1', role: 'backend' as const, y: 30 },
    ...artifact.scenario.topology.clients.flatMap((client, index) => [
      {
        key: leaderComponentKey(client.id),
        label: `${client.id} · Leader`,
        color: clientColor(index),
        role: 'leader' as const,
        y: 0,
      },
      ...client.sessions.map((sessionId) => ({
        key: sessionComponentKey(client.id, sessionId),
        label: sessionId,
        color: clientColor(index),
        role: 'session' as const,
        y: 0,
      })),
    ]),
  ].map((lane, index) => ({ ...lane, y: index * 62 + 30 }))
  const laneByKey = new Map(lanes.map((lane) => [lane.key, lane]))
  const yAt = (key: string): number => laneByKey.get(key)?.y ?? 30

  const width = 1400
  const left = 180
  const right = 35
  const carpetTop = lanes.length * 62 + 36
  const height = carpetTop + 54
  const plotWidth = width - left - right

  const traceProjectionUnits = new Map<string, number>()
  const traceUnitByRecord = new Map<number, number>()
  for (const record of trace) {
    const key = record.captureId === null ? `record:${record.index}` : `capture:${record.captureId}`
    let unit = traceProjectionUnits.get(key)
    if (unit === undefined) {
      unit = traceProjectionUnits.size
      traceProjectionUnits.set(key, unit)
    }
    traceUnitByRecord.set(record.index, unit)
  }
  const evidenceUnitByRecord = new Map<number, number>()
  let firstUnassignedRecordIndex = 0
  for (const moment of playbackMoments) {
    for (let index = firstUnassignedRecordIndex; index <= moment.recordIndex; index += 1) {
      evidenceUnitByRecord.set(index, moment.momentIndex)
    }
    firstUnassignedRecordIndex = moment.recordIndex + 1
  }
  const finalEvidenceUnit = Math.max(playbackMoments.length - 1, 0)
  for (let index = firstUnassignedRecordIndex; index < trace.length; index += 1) {
    evidenceUnitByRecord.set(index, finalEvidenceUnit)
  }
  const flowMax = Math.max(
    traceVisibility === 'evidence' ? playbackMoments.length - 1 : traceProjectionUnits.size - 1,
    1,
  )
  const recordTimes = trace.map((record) =>
    record.calibratedTime === null
      ? record.coordinatorReceiptMonotonicMs
      : (record.calibratedTime.earliestMs + record.calibratedTime.latestMs) / 2,
  )
  const timeMin = Math.min(
    ...trace.map((record) => record.calibratedTime?.earliestMs ?? record.coordinatorReceiptMonotonicMs),
    0,
  )
  const timeMax = Math.max(
    ...trace.map((record) => record.calibratedTime?.latestMs ?? record.coordinatorReceiptMonotonicMs),
    timeMin + 1,
  )
  const adaptiveTimeLayout = deriveAdaptiveTimeLayout([timeMin, ...recordTimes, timeMax])
  const normalizedRawTime = (time: number): number => (time - timeMin) / (timeMax - timeMin)
  const normalizedFittedTime = (time: number): number => projectAdaptiveTime(adaptiveTimeLayout, time)
  const normalizedForRecord = (recordIndex: number): number => {
    if (timelineMode === 'flow') {
      const unit =
        traceVisibility === 'evidence'
          ? (evidenceUnitByRecord.get(recordIndex) ?? finalEvidenceUnit)
          : (traceUnitByRecord.get(recordIndex) ?? 0)
      return unit / flowMax
    }
    const time = recordTimes[recordIndex] ?? timeMin
    return timeScaleMode === 'fit' ? normalizedFittedTime(time) : normalizedRawTime(time)
  }
  const normalizedRecordPositions = trace.map((record) => normalizedForRecord(record.index))
  const viewportSpan = viewport.end - viewport.start
  const xForNormalized = (position: number): number => left + ((position - viewport.start) / viewportSpan) * plotWidth
  const overviewXForNormalized = (position: number): number => left + position * plotWidth
  const isVisibleNormalized = (position: number): boolean => position >= viewport.start && position <= viewport.end
  const isVisibleRecord = (recordIndex: number): boolean => isVisibleNormalized(normalizedForRecord(recordIndex))
  const rawOverviewXForTime = (time: number): number => overviewXForNormalized(normalizedRawTime(time))
  const xForTime = (time: number): number =>
    xForNormalized(timeScaleMode === 'fit' ? normalizedFittedTime(time) : normalizedRawTime(time))
  const xForRecord = (recordIndex: number): number => xForNormalized(normalizedForRecord(recordIndex))
  const xForCarpetRecord = (recordIndex: number): number =>
    timelineMode === 'time' && timeScaleMode === 'fit'
      ? rawOverviewXForTime(recordTimes[recordIndex] ?? timeMin)
      : xForRecord(recordIndex)
  const scrubRecordIndexes =
    traceVisibility === 'evidence'
      ? playbackMoments.map((moment) => moment.recordIndex)
      : trace.map((record) => record.index)
  const scrubPositions = scrubRecordIndexes.filter(isVisibleRecord).map((index) => ({ index, x: xForRecord(index) }))

  const positionedByLane = new Map(
    [...Map.groupBy(markers, (marker) => marker.componentKey)].map(([componentKey, laneMarkers]) => [
      componentKey,
      laneMarkers
        .filter((marker) => isVisibleRecord(marker.recordIndex))
        .map((marker) => ({ marker, x: xForRecord(marker.recordIndex) }))
        .toSorted((a, b) => a.x - b.x),
    ]),
  )
  const maximumLaneMarkerCount = Math.max(0, ...[...positionedByLane.values()].map((laneMarkers) => laneMarkers.length))
  const averageMarkerSpacing = maximumLaneMarkerCount === 0 ? plotWidth : plotWidth / maximumLaneMarkerCount
  const markerMode = averageMarkerSpacing >= 54 ? 'label' : averageMarkerSpacing >= 7 ? 'point' : 'aggregate'

  const eventMarkers = [...positionedByLane.values()]
    .flatMap((laneMarkers) =>
      markerMode === 'label'
        ? laneMarkers.map((positioned) => [positioned])
        : groupMarkersIntoBins({ markers: laneMarkers, left, binWidth: markerMode === 'point' ? 7 : 14 }),
    )
    .map((group) => {
      const first = group[0]!
      const selected = group.some(({ marker }) => marker.event.eventRef === selectedEventRef) === true ? 'selected' : ''
      const pending = group.some(({ marker }) => marker.event.disposition === 'pending') === true ? 'pending' : ''
      const future = group.every(({ marker }) => marker.recordIndex > cursorIndex) === true ? 'future' : ''
      const recordIndex = Math.max(...group.map(({ marker }) => marker.recordIndex))
      const x = group.reduce((total, item) => total + item.x, 0) / group.length
      const y = yAt(first.marker.componentKey)
      const eventRef = group.length === 1 ? first.marker.event.eventRef : undefined
      const originClientId = group.length === 1 ? first.marker.event.origin.clientId : undefined
      const originColor = originClientId === undefined ? undefined : clientColorsById.get(originClientId)
      const tooltipContent = timelineEventTooltipContent(group.map(({ marker }) => marker.event))
      const commonAttrs = {
        class: `marker ${markerMode === 'label' ? 'marker-label' : `event-point ${markerMode}`} ${originColor === undefined ? '' : 'origin-colored'} ${pending} ${selected} ${future}`,
        'data-event-ref': eventRef,
        'data-origin-client-id': originClientId,
        'data-record-index': recordIndex,
        color: originColor,
      }
      if (markerMode === 'label') {
        const marker = first.marker
        const uncertainty =
          timelineMode === 'time' &&
          marker.calibratedTime !== null &&
          marker.calibratedTime.latestMs > marker.calibratedTime.earliestMs
            ? [
                node('line', {
                  class: 'time-uncertainty',
                  x1: xForTime(marker.calibratedTime.earliestMs) - (x - 24),
                  x2: xForTime(marker.calibratedTime.latestMs) - (x - 24),
                  y1: 10,
                  y2: 10,
                }),
              ]
            : []
        return withTooltip(
          tooltipContent,
          node('g', { ...commonAttrs, transform: `translate(${x - 24} ${y - 10})` }, [
            ...uncertainty,
            node('rect', { width: 48, height: 20, rx: 3 }),
            node('text', { x: 24, y: 14, 'text-anchor': 'middle' }, undefined, displayEventPosition(marker.event)),
          ]),
        )
      }
      const radius = group.length === 1 ? 3.8 : Math.min(8, 3.8 + Math.log2(group.length))
      const markerNode = node('g', commonAttrs, [
        node('circle', { cx: x, cy: y, r: radius }),
        ...(group.length > 1 && radius >= 5.8
          ? [node('text', { x, y: y + 2.3, 'text-anchor': 'middle' }, undefined, String(group.length))]
          : []),
      ])
      return withTooltip(tooltipContent, markerNode)
    })

  const compressedGaps =
    timelineMode === 'time' && timeScaleMode === 'fit'
      ? adaptiveTimeLayout.compressedGaps
          .filter(
            (gap) =>
              gap.endPosition >= viewport.start &&
              gap.startPosition <= viewport.end &&
              ((Math.min(gap.endPosition, viewport.end) - Math.max(gap.startPosition, viewport.start)) / viewportSpan) *
                plotWidth >=
                38,
          )
          .flatMap((gap) => {
            const x1 = xForNormalized(Math.max(gap.startPosition, viewport.start))
            const x2 = xForNormalized(Math.min(gap.endPosition, viewport.end))
            const midpoint = (x1 + x2) / 2
            return [
              node('rect', { class: 'compressed-gap-band', x: x1, y: 3, width: x2 - x1, height: carpetTop - 11 }),
              node('line', { class: 'compressed-gap-edge', x1, x2: x1, y1: 3, y2: carpetTop - 8 }),
              node('line', { class: 'compressed-gap-edge', x1: x2, x2, y1: 3, y2: carpetTop - 8 }),
              node(
                'text',
                { class: 'compressed-gap-label', x: midpoint, y: 11, 'text-anchor': 'middle' },
                undefined,
                `// ${formatDuration(gap.durationMs)} //`,
              ),
            ]
          })
      : []

  const connectivityBands = connectivityIntervals.flatMap((interval) => {
    const client = clientsById.get(interval.clientId)
    if (client === undefined) return []
    const intervalStart = normalizedForRecord(interval.startRecordIndex)
    const endRecordIndex = interval.endRecordIndex ?? trace.at(-1)?.index ?? interval.startRecordIndex
    const intervalEnd = normalizedForRecord(endRecordIndex)
    if (intervalEnd < viewport.start || intervalStart > viewport.end) return []
    const x1 = xForNormalized(Math.max(intervalStart, viewport.start))
    const x2 = Math.max(xForNormalized(Math.min(intervalEnd, viewport.end)), x1 + 2)
    const leaderY = yAt(leaderComponentKey(client.id))
    const lastSessionId = client.sessions.at(-1)
    const lastSessionY = lastSessionId === undefined ? leaderY : yAt(sessionComponentKey(client.id, lastSessionId))
    const y = leaderY - 23
    const uncertain = interval.startEvidence === 'first-observed' || interval.endEvidence === 'first-observed'
    const boundaryDescription = `${interval.startEvidence} → ${interval.endEvidence ?? 'still disconnected'}`
    return [
      withTooltip(
        `${interval.clientId} offline · ${boundaryDescription}`,
        node('g', { class: `offline-period ${uncertain === true ? 'uncertain' : ''}` }, [
          node('rect', { x: x1, y, width: x2 - x1, height: lastSessionY - leaderY + 46, rx: 2 }),
          ...(x2 - x1 >= 92
            ? [node('text', { class: 'offline-period-label', x: x1 + 6, y: y + 12 }, undefined, 'OFFLINE')]
            : []),
        ]),
      ),
    ]
  })

  const settlementFailures = trace.filter((record) => record.payload._tag === 'settlement.failed')
  const failureRecords =
    settlementFailures.length > 0 ? settlementFailures : trace.filter((record) => record.payload._tag === 'run.failed')
  const failureBoundaries = failureRecords
    .filter((record) => isVisibleRecord(record.index))
    .map((record) => {
      const x = xForRecord(record.index)
      const message = 'message' in record.payload ? record.payload.message : 'Scenario execution failed'
      return withTooltip(
        message,
        node('g', { class: 'failure-boundary', 'data-record-index': record.index }, [
          node('line', { x1: x, x2: x, y1: 3, y2: carpetTop - 8 }),
          node('path', { d: `M ${x} 3 l 7 7 l -7 7 l -7 -7 z` }),
          node('text', { x: x - 7, y: 13, 'text-anchor': 'end' }, undefined, 'RUN FAILED'),
        ]),
      )
    })

  const momentByRecordIndex = new Map(playbackMoments.map((moment) => [moment.recordIndex, moment]))
  const participantMilestones = trace
    .filter((record) => isVisibleRecord(record.index))
    .flatMap((record) => {
      const x = xForRecord(record.index)
      const title = momentByRecordIndex.get(record.index)?.summary ?? record.payload._tag
      const client = record.clientId === null ? undefined : clientsById.get(record.clientId)
      const leaderY = client === undefined ? undefined : yAt(leaderComponentKey(client.id))
      const lastSessionId = client?.sessions.at(-1)
      const groupEndY =
        client === undefined || leaderY === undefined
          ? undefined
          : lastSessionId === undefined
            ? leaderY
            : yAt(sessionComponentKey(client.id, lastSessionId))
      const milestone = (className: string, children: ReadonlyArray<SvgSceneNode>): ReadonlyArray<SvgSceneNode> => [
        withTooltip(
          title,
          node('g', { class: `participant-milestone ${className}`, 'data-record-index': record.index }, children),
        ),
      ]
      switch (record.payload._tag) {
        case 'client.created':
          return leaderY === undefined || groupEndY === undefined
            ? []
            : milestone('topology', [
                node('line', { class: 'group-boundary', x1: x, x2: x, y1: leaderY - 10, y2: groupEndY + 10 }),
                node('path', { d: `M ${x} ${leaderY - 6} l 6 6 l -6 6 l -6 -6 z` }),
              ])
        case 'connectivity.disconnected':
        case 'connectivity.reconnected':
          return leaderY === undefined || groupEndY === undefined
            ? []
            : milestone(
                `connectivity ${record.payload._tag.endsWith('disconnected') === true ? 'disconnected' : 'reconnected'}`,
                [
                  node('line', { x1: x, x2: x, y1: leaderY - 7, y2: groupEndY + 7 }),
                  node('circle', { cx: x, cy: leaderY, r: 3.5 }),
                ],
              )
        case 'lifecycle.session-stopped':
        case 'lifecycle.session-restarted': {
          if (record.clientId === null || record.sessionId === null) return []
          const y = yAt(sessionComponentKey(record.clientId, record.sessionId))
          const restarted = record.payload._tag === 'lifecycle.session-restarted'
          return milestone(`lifecycle ${restarted === true ? 'restarted' : 'stopped'}`, [
            node('line', { x1: x, x2: x, y1: y - 8, y2: y + 8 }),
            node('circle', { cx: x, cy: y, r: 4 }),
          ])
        }
        case 'lifecycle.client-restarted':
          return leaderY === undefined || groupEndY === undefined
            ? []
            : milestone('lifecycle restarted', [
                node('line', { x1: x, x2: x, y1: leaderY - 8, y2: groupEndY + 8 }),
                node('circle', { cx: x, cy: leaderY, r: 4 }),
              ])
        default:
          return []
      }
    })

  const runtimeFailures = runtimeFailureIntervals.flatMap((interval) => {
    const start = normalizedForRecord(interval.startRecordIndex)
    const endRecordIndex = interval.endRecordIndex ?? trace.at(-1)?.index ?? interval.startRecordIndex
    const end = normalizedForRecord(endRecordIndex)
    if (end < viewport.start || start > viewport.end) return []
    const x1 = xForNormalized(Math.max(start, viewport.start))
    const x2 = Math.max(xForNormalized(Math.min(Math.max(start, end), viewport.end)), x1 + 2)
    const y = yAt(interval.componentKey)
    const failureTrackY = y + 23
    const originVisible = start >= viewport.start && start <= viewport.end
    const terminalStartX = originVisible === true ? Math.min(x1 + 7, x2) : x1
    const duplicateCount = interval.recordIndexes.length
    const title = `${interval.clientId}${interval.sessionId === null ? '' : `/${interval.sessionId}`}: runtime failure: ${interval.summary}${duplicateCount > 1 ? ` · ${duplicateCount} related records` : ''}`
    return [
      withTooltip(
        title,
        node('g', { class: 'runtime-failure-interval' }, [
          node('line', {
            class: 'runtime-failure-terminal',
            x1: terminalStartX,
            x2,
            y1: failureTrackY,
            y2: failureTrackY,
          }),
          ...(originVisible === true
            ? [
                node('g', { class: 'runtime-failure-callout', 'data-record-index': interval.startRecordIndex }, [
                  node('line', { x1, x2: x1, y1: y + 12, y2: failureTrackY - 5 }),
                  node('path', { d: `M ${x1} ${failureTrackY - 5} l 5 5 l -5 5 l -5 -5 z` }),
                  node('text', { x: x1 - 8, y: y + 40, 'text-anchor': 'end' }, undefined, 'RUNTIME FAILURE'),
                ]),
              ]
            : []),
        ]),
      ),
    ]
  })

  const captureGuides = captures
    .filter(
      (capture) =>
        (traceVisibility === 'trace' || evidenceCaptureIds.has(capture.captureId)) &&
        isVisibleRecord(traceVisibility === 'evidence' ? capture.lastRecordIndex : capture.firstRecordIndex),
    )
    .map((capture) => {
      const x = xForRecord(traceVisibility === 'evidence' ? capture.lastRecordIndex : capture.firstRecordIndex)
      return withTooltip(
        `capture ${capture.captureIndex + 1} · non-atomic sampling pass`,
        node('line', { class: 'capture-guide', x1: x, x2: x, y1: 12, y2: carpetTop - 8 }),
      )
    })

  const captureStack = new Map<string, number>()
  const traceCarpet = [
    node(
      'text',
      { class: 'trace-carpet-label', x: 8, y: carpetTop + 18 },
      undefined,
      `${traceVisibility === 'evidence' ? 'SYNC EVIDENCE' : 'RAW TRACE'}${timelineMode === 'time' && timeScaleMode === 'fit' ? ' · RAW TIME' : ''}`,
    ),
    ...(traceVisibility === 'evidence'
      ? playbackMoments
          .filter(
            (moment) => (timelineMode === 'time' && timeScaleMode === 'fit') || isVisibleRecord(moment.recordIndex),
          )
          .map((moment) => {
            const record = trace[moment.recordIndex]!
            const representedRecord = trace[moment.recordIndexes[0] ?? moment.recordIndex]!
            const radius = moment.kind === 'capture' ? 2.1 : moment.kind === 'failure' ? 3.8 : 3.2
            const commonAttrs = {
              class: `evidence-moment moment-${moment.kind} ${record.evidence} ${moment.recordIndexes.includes(cursorIndex) === true ? 'selected' : ''}`,
              'data-record-index': moment.recordIndex,
            }
            const workloadCount =
              representedRecord.payload._tag === 'workload.requested' ? representedRecord.payload.count : undefined
            return withTooltip(
              `moment ${moment.momentIndex + 1} · ${moment.label} · ${moment.summary} · record ${moment.recordIndex + 1}`,
              workloadCount === undefined
                ? node('circle', {
                    ...commonAttrs,
                    class: `trace-dot ${commonAttrs.class}`,
                    cx: xForCarpetRecord(moment.recordIndex),
                    cy: carpetTop + 15,
                    r: radius,
                  })
                : node('g', { ...commonAttrs, class: `trace-workload ${commonAttrs.class}` }, [
                    node('rect', {
                      x: xForCarpetRecord(moment.recordIndex) - 29,
                      y: carpetTop + 8,
                      width: 58,
                      height: 14,
                      rx: 7,
                    }),
                    node(
                      'text',
                      { x: xForCarpetRecord(moment.recordIndex), y: carpetTop + 18, 'text-anchor': 'middle' },
                      undefined,
                      `${workloadCount} actions`,
                    ),
                  ]),
            )
          })
      : trace
          .filter((record) => (timelineMode === 'time' && timeScaleMode === 'fit') || isVisibleRecord(record.index))
          .map((record) => {
            const stack = record.captureId === null ? 0 : (captureStack.get(record.captureId) ?? 0)
            if (record.captureId !== null) captureStack.set(record.captureId, stack + 1)
            return withTooltip(
              `#${record.index + 1} · ${record.payload._tag} · ${record.evidence}`,
              node('circle', {
                class: `trace-dot ${record.evidence} ${record.index === cursorIndex ? 'selected' : ''}`,
                'data-record-index': record.index,
                cx: xForCarpetRecord(record.index),
                cy: carpetTop + 15 + (stack % 4) * 7,
                r: 2.8,
              }),
            )
          })),
  ]

  const laneHierarchy = artifact.scenario.topology.clients.flatMap((client) => {
    if (client.sessions.length === 0) return []
    const leaderY = yAt(leaderComponentKey(client.id))
    const sessionYs = client.sessions.map((sessionId) => yAt(sessionComponentKey(client.id, sessionId)))
    return [
      node('path', { class: 'lane-hierarchy', d: `M 19 ${leaderY + 11} V ${sessionYs.at(-1)!}` }),
      ...sessionYs.map((sessionY) => node('path', { class: 'lane-hierarchy', d: `M 19 ${sessionY} H 30` })),
    ]
  })
  const laneLayer = lanes.flatMap((lane) => {
    const activeSegments = laneActivityIntervals
      .filter((interval) => interval.componentKey === lane.key)
      .flatMap((interval) => {
        const intervalStart = normalizedForRecord(interval.startRecordIndex)
        const intervalEnd = interval.endRecordIndex === null ? 1 : normalizedForRecord(interval.endRecordIndex)
        const start = Math.min(intervalStart, intervalEnd)
        const end = Math.max(intervalStart, intervalEnd)
        if (end < viewport.start || start > viewport.end) return []
        const x1 = xForNormalized(Math.max(start, viewport.start))
        const x2 = xForNormalized(Math.min(end, viewport.end))
        return [
          node('line', {
            class: 'lane-track active',
            x1,
            x2: Math.max(x2, x1 + 1),
            y1: lane.y,
            y2: lane.y,
            stroke: lane.color,
          }),
        ]
      })
    return [
      node(
        'text',
        { class: `lane-label ${lane.role}`, x: lane.role === 'session' ? 36 : 8, y: lane.y + 4 },
        undefined,
        lane.label,
      ),
      node('line', {
        class: 'lane-track declared',
        x1: left,
        x2: width - right,
        y1: lane.y,
        y2: lane.y,
        stroke: lane.color,
      }),
      ...activeSegments,
    ]
  })

  const densityBinCount = 160
  const densityBins = Array.from({ length: densityBinCount }, () => 0)
  for (const marker of markers) {
    const bin = Math.min(
      Math.max(Math.floor(normalizedForRecord(marker.recordIndex) * densityBinCount), 0),
      densityBinCount - 1,
    )
    densityBins[bin] = (densityBins[bin] ?? 0) + 1
  }
  const maximumDensity = Math.max(1, ...densityBins)
  const densityLayer = densityBins.flatMap((count, index) => {
    if (count === 0) return []
    const barWidth = plotWidth / densityBinCount
    const barHeight = 3 + (Math.log1p(count) / Math.log1p(maximumDensity)) * 18
    return [
      node('rect', {
        class: 'range-density-bar',
        x: left + index * barWidth,
        y: 34 - barHeight,
        width: Math.max(barWidth - 0.6, 0.8),
        height: barHeight,
      }),
    ]
  })
  const conditionLayer = [
    ...connectivityIntervals.map((interval) => {
      const start = normalizedForRecord(interval.startRecordIndex)
      const endRecordIndex = interval.endRecordIndex ?? trace.at(-1)?.index ?? interval.startRecordIndex
      const x1 = overviewXForNormalized(start)
      const x2 = Math.max(overviewXForNormalized(normalizedForRecord(endRecordIndex)), x1 + 1)
      return withTooltip(
        `${interval.clientId} offline`,
        node('rect', { class: 'range-offline-period', x: x1, y: 30, width: x2 - x1, height: 4 }),
      )
    }),
    ...runtimeFailureIntervals.map((interval) => {
      const x = overviewXForNormalized(normalizedForRecord(interval.startRecordIndex))
      const participant = `${interval.clientId}${interval.sessionId === null ? '' : `/${interval.sessionId}`}`
      return withTooltip(
        `${participant}: ${interval.summary}`,
        node('line', { class: 'range-runtime-failure', x1: x, x2: x, y1: 18, y2: 36 }),
      )
    }),
  ]
  const failureLayer = failureRecords.map((record) => {
    const x = overviewXForNormalized(normalizedForRecord(record.index))
    return withTooltip(record.payload._tag, node('line', { class: 'range-failure', x1: x, x2: x, y1: 5, y2: 37 }))
  })
  const rangeStartX = overviewXForNormalized(viewport.start)
  const rangeEndX = overviewXForNormalized(viewport.end)
  const rangeSummary =
    viewport.start === 0 && viewport.end === 1
      ? 'full run'
      : `${Math.round(viewport.start * 100)}–${Math.round(viewport.end * 100)}%`
  const windowLayer = [
    node('text', { class: 'range-label', x: 8, y: 26 }, undefined, 'RANGE'),
    node('text', { class: 'range-summary', x: width - right, y: 10, 'text-anchor': 'end' }, undefined, rangeSummary),
    node('rect', {
      class: 'range-track',
      x: left,
      y: 7,
      width: plotWidth,
      height: 28,
      rx: 2,
      'data-range-action': 'track',
    }),
    withTooltip(
      'Drag to pan the visible timeline range',
      node('rect', {
        class: 'range-window',
        x: rangeStartX,
        y: 5,
        width: rangeEndX - rangeStartX,
        height: 32,
        rx: 2,
        'data-range-action': 'window',
      }),
    ),
    node('g', { class: 'range-handle start', 'data-range-action': 'start' }, [
      node('rect', { class: 'range-handle-hit', x: rangeStartX - 7, y: 2, width: 14, height: 38 }),
      node('line', { x1: rangeStartX, x2: rangeStartX, y1: 3, y2: 39 }),
    ]),
    node('g', { class: 'range-handle end', 'data-range-action': 'end' }, [
      node('rect', { class: 'range-handle-hit', x: rangeEndX - 7, y: 2, width: 14, height: 38 }),
      node('line', { x1: rangeEndX, x2: rangeEndX, y1: 3, y2: 39 }),
    ]),
  ]
  const overviewCursorX = cursorIndex < 0 ? undefined : overviewXForNormalized(normalizedForRecord(cursorIndex))
  const mainCursorVisible = cursorIndex >= 0 && isVisibleRecord(cursorIndex)
  const cursorLayer = [
    ...(mainCursorVisible === true
      ? [
          node('line', {
            class: 'cursor-line',
            x1: xForRecord(cursorIndex),
            x2: xForRecord(cursorIndex),
            y1: 10,
            y2: timelineMode === 'time' && timeScaleMode === 'fit' ? carpetTop - 8 : height - 10,
          }),
          node('circle', { class: 'cursor-handle', cx: xForRecord(cursorIndex), cy: 9, r: 6 }),
        ]
      : []),
    ...(cursorIndex >= 0 && timelineMode === 'time' && timeScaleMode === 'fit'
      ? [
          node('line', {
            class: 'carpet-cursor',
            x1: xForCarpetRecord(cursorIndex),
            x2: xForCarpetRecord(cursorIndex),
            y1: carpetTop + 5,
            y2: height - 7,
          }),
        ]
      : []),
  ]

  return {
    lanes,
    tooltipContentById,
    scrubPositions,
    markerMode,
    normalizedRecordPositions,
    mainCursorVisible,
    main: {
      width,
      height,
      carpetTop,
      compressedGaps,
      connectivityBands,
      failureBoundaries,
      laneHierarchy,
      laneLayer,
      participantMilestones,
      captureGuides,
      eventMarkers,
      runtimeFailures,
      traceCarpet,
      cursorLayer: [node('g', { class: 'cursor-scrubber', 'aria-hidden': 'true' }, cursorLayer)],
    },
    range: {
      width,
      height: 44,
      rangeSummary,
      densityLayer,
      conditionLayer,
      failureLayer,
      windowLayer,
      cursorLayer:
        overviewCursorX === undefined
          ? []
          : [
              withTooltip(
                'Current trace cursor',
                node('line', { class: 'range-cursor', x1: overviewCursorX, x2: overviewCursorX, y1: 4, y2: 39 }),
              ),
            ],
    },
  }
}

/** Keeps the overview brush ordered, bounded, and large enough to remain operable. */
export const clampTimelineViewport = (requestedStart: number, requestedEnd: number): TimelineViewport => {
  const minimumSpan = 0.01
  const requestedSpan = requestedEnd - requestedStart
  const span = clamp(requestedSpan, minimumSpan, 1)
  let start = requestedStart
  if (requestedSpan < minimumSpan) start = (requestedStart + requestedEnd) / 2 - span / 2
  start = clamp(start, 0, 1 - span)
  return { start, end: start + span }
}

/** Groups only markers in the same visual bin, preventing transitive lane-wide aggregation. */
export const groupMarkersIntoBins = ({
  markers,
  left,
  binWidth,
}: {
  readonly markers: ReadonlyArray<PositionedTimelineMarker>
  readonly left: number
  readonly binWidth: number
}): ReadonlyArray<ReadonlyArray<PositionedTimelineMarker>> => {
  const bins = new Map<number, PositionedTimelineMarker[]>()
  for (const marker of markers) {
    const bin = Math.floor((marker.x - left) / binWidth)
    const group = bins.get(bin) ?? []
    group.push(marker)
    bins.set(bin, group)
  }
  return [...bins.entries()].toSorted(([a], [b]) => a - b).map(([, group]) => group)
}

export const displayEventPosition = (event: Pick<ObservedEvent, 'position' | 'disposition'>): string =>
  event.disposition === 'pending' ? `${event.position}'` : event.position

export const clientColor = (index: number): string => ['#088361', '#d8662c', '#9c3cc0', '#08759c'][index % 4]!

const formatDuration = (durationMs: number): string =>
  durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 1 : 2)}s` : `${Math.round(durationMs)}ms`

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(Math.max(value, minimum), maximum)
