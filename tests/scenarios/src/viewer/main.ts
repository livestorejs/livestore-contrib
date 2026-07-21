import { Schema } from '@livestore/utils/effect'

import { type ComponentSyncObservation, type ObservedEvent, ScenarioRunArtifact } from '../model.ts'
import {
  backendComponentKey,
  deriveAdaptiveTimeLayout,
  deriveEventTimeline,
  derivePlaybackMoments,
  deriveTraceCaptures,
  leaderComponentKey,
  projectTraceAt,
  projectAdaptiveTime,
  sessionComponentKey,
} from '../projection.ts'
import './style.css'

const requireElement = <T extends Element>(id: string, constructor: { new (): T }): T => {
  const element = document.getElementById(id)
  if (element === null || element instanceof constructor === false) throw new Error(`Missing #${id}`)
  return element
}

const fileInput = requireElement('artifact-file', HTMLInputElement)
const exampleArtifactSelectElement = document.getElementById('example-artifact')
if (exampleArtifactSelectElement instanceof HTMLSelectElement === false) throw new Error('Missing #example-artifact')
const exampleArtifactSelect = exampleArtifactSelectElement
const loadExampleButton = requireElement('load-example', HTMLButtonElement)
const playButton = requireElement('play', HTMLButtonElement)
const runTitle = requireElement('run-title', HTMLElement)
const runSummary = requireElement('run-summary', HTMLElement)
const traceName = requireElement('trace-name', HTMLElement)
const cursorLabel = requireElement('cursor-label', HTMLElement)
const recordLabel = requireElement('record-label', HTMLElement)
const modeFlowButton = requireElement('mode-flow', HTMLButtonElement)
const modeTimeButton = requireElement('mode-time', HTMLButtonElement)
const timeScaleSwitch = requireElement('time-scale-switch', HTMLElement)
const timeFitButton = requireElement('time-fit', HTMLButtonElement)
const timeRawButton = requireElement('time-raw', HTMLButtonElement)
const visibilitySystemButton = requireElement('visibility-system', HTMLButtonElement)
const visibilityAllButton = requireElement('visibility-all', HTMLButtonElement)
const playbackMomentsButton = requireElement('playback-moments', HTMLButtonElement)
const playbackRecordsButton = requireElement('playback-records', HTMLButtonElement)
const timelineModeNote = requireElement('timeline-mode-note', HTMLElement)
const runStatus = requireElement('run-status', HTMLElement)
const systemState = requireElement('system-state', HTMLElement)
const timeline = requireElement('timeline', HTMLElement)
const eventSelection = requireElement('event-selection', HTMLElement)
const recordDetails = requireElement('record-details', HTMLElement)

let artifact: ScenarioRunArtifact | undefined
let cursorIndex = -1
let selectedEventRef: string | undefined
let playTimer: number | undefined
let timelineMode: 'flow' | 'time' = 'flow'
let timeScaleMode: 'fit' | 'raw' = 'fit'
let traceVisibility: 'system' | 'all' = 'system'
let playbackMode: 'moments' | 'records' = 'moments'
let playbackMoments: ReturnType<typeof derivePlaybackMoments> = []
let timelineRecordPositions: ReadonlyArray<{ readonly index: number; readonly x: number }> = []
let timelineViewport = { start: 0, end: 1 }
const eventlogScrollStates = new Map<string, { followTail: boolean; scrollLeft: number }>()
type PositionedTimelineMarker = {
  readonly marker: ReturnType<typeof deriveEventTimeline>[number]
  readonly x: number
}
type TimelineLane = {
  readonly key: string
  readonly label: string
  readonly color: string
  readonly role: 'backend' | 'leader' | 'session'
}

modeFlowButton.addEventListener('click', () => setTimelineMode('flow'))
modeTimeButton.addEventListener('click', () => setTimelineMode('time'))
timeFitButton.addEventListener('click', () => setTimeScaleMode('fit'))
timeRawButton.addEventListener('click', () => setTimeScaleMode('raw'))
visibilitySystemButton.addEventListener('click', () => setTraceVisibility('system'))
visibilityAllButton.addEventListener('click', () => setTraceVisibility('all'))
playbackMomentsButton.addEventListener('click', () => setPlaybackMode('moments'))
playbackRecordsButton.addEventListener('click', () => setPlaybackMode('records'))

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file === undefined) return
  void file.text().then(loadArtifactJson).catch(showLoadError)
})

loadExampleButton.addEventListener('click', () => {
  const file = exampleArtifactSelect.value
  if (file.length === 0) return
  void fetch(`/${encodeURIComponent(file)}`)
    .then(async (response) => {
      if (response.ok === false) throw new Error(`Could not load saved artifact ${file}.`)
      return response.text()
    })
    .then(loadArtifactJson)
    .catch(showLoadError)
})

exampleArtifactSelect.addEventListener('change', () => {
  loadExampleButton.disabled = exampleArtifactSelect.value.length === 0
})

interface ArtifactCatalog {
  readonly version: 1
  readonly entries: ReadonlyArray<{
    readonly file: string
    readonly label: string
    readonly applicationEventCount: number
    readonly traceRecordCount: number
  }>
}

const loadArtifactCatalog = async (): Promise<void> => {
  const response = await fetch('/catalog.json')
  if (response.ok === false) throw new Error('Run a scenario to generate the saved-run catalog.')
  const catalog = (await response.json()) as ArtifactCatalog
  exampleArtifactSelect.replaceChildren(
    new Option('select saved run', ''),
    ...catalog.entries.map(
      (entry) =>
        new Option(
          `${entry.label} · ${entry.applicationEventCount} events · ${entry.traceRecordCount} traces`,
          entry.file,
        ),
    ),
  )
  exampleArtifactSelect.disabled = catalog.entries.length === 0
}

void loadArtifactCatalog().catch((cause) => {
  exampleArtifactSelect.replaceChildren(new Option(cause instanceof Error ? cause.message : String(cause), ''))
})

playButton.addEventListener('click', () => {
  if (playTimer !== undefined) {
    stopPlayback()
    return
  }
  if (artifact === undefined) return
  const indexes = playbackCursorIndexes()
  if (cursorIndex >= (indexes.at(-1) ?? -1)) cursorIndex = -1
  playButton.textContent = 'pause'
  playTimer = window.setInterval(() => {
    if (artifact === undefined) {
      stopPlayback()
      return
    }
    const nextCursor = playbackCursorIndexes().find((index) => index > cursorIndex)
    if (nextCursor === undefined) {
      stopPlayback()
      return
    }
    cursorIndex = nextCursor
    render()
  }, 180)
})

const loadArtifactJson = (input: string): void => {
  stopPlayback()
  artifact = Schema.decodeUnknownSync(Schema.fromJsonString(ScenarioRunArtifact))(input)
  playbackMoments = derivePlaybackMoments({ scenario: artifact.scenario, trace: artifact.trace })
  cursorIndex = artifact.trace.length - 1
  selectedEventRef = undefined
  timelineViewport = { start: 0, end: 1 }
  eventlogScrollStates.clear()
  playButton.disabled = false
  runTitle.textContent = artifact.descriptor.scenarioId
  runSummary.textContent = `${artifact.scenario.description} · seed ${artifact.descriptor.seed}`
  traceName.textContent = artifact.descriptor.runId
  traceName.title = artifact.descriptor.runId
  render()
}

const showLoadError = (cause: unknown): void => {
  runSummary.textContent = cause instanceof Error ? cause.message : String(cause)
  runStatus.className = 'badge bad'
  runStatus.textContent = 'Load failed'
}

const stopPlayback = (): void => {
  if (playTimer !== undefined) window.clearInterval(playTimer)
  playTimer = undefined
  playButton.textContent = 'play'
}

const setTimelineMode = (mode: 'flow' | 'time'): void => {
  timelineMode = mode
  timelineViewport = { start: 0, end: 1 }
  modeFlowButton.setAttribute('aria-pressed', String(mode === 'flow'))
  modeTimeButton.setAttribute('aria-pressed', String(mode === 'time'))
  timeScaleSwitch.hidden = mode !== 'time'
  timelineModeNote.textContent =
    mode === 'flow' ? 'Observation captures are aligned; no causal arrows are inferred.' : timeScaleDescription()
  render()
}

const setTimeScaleMode = (mode: 'fit' | 'raw'): void => {
  timeScaleMode = mode
  timelineViewport = { start: 0, end: 1 }
  timeFitButton.setAttribute('aria-pressed', String(mode === 'fit'))
  timeRawButton.setAttribute('aria-pressed', String(mode === 'raw'))
  timelineModeNote.textContent = timeScaleDescription()
  render()
}

const setTraceVisibility = (visibility: 'system' | 'all'): void => {
  traceVisibility = visibility
  visibilitySystemButton.setAttribute('aria-pressed', String(visibility === 'system'))
  visibilityAllButton.setAttribute('aria-pressed', String(visibility === 'all'))
  render()
}

const setPlaybackMode = (mode: 'moments' | 'records'): void => {
  stopPlayback()
  playbackMode = mode
  playbackMomentsButton.setAttribute('aria-pressed', String(mode === 'moments'))
  playbackRecordsButton.setAttribute('aria-pressed', String(mode === 'records'))
  render()
}

const playbackCursorIndexes = (): ReadonlyArray<number> => {
  if (artifact === undefined) return []
  if (playbackMode === 'moments' && playbackMoments.length > 0) {
    return playbackMoments.map((moment) => moment.recordIndex)
  }
  return artifact.trace.map((record) => record.index)
}

const timeScaleDescription = (): string =>
  timeScaleMode === 'fit'
    ? 'Calibrated time with labelled long gaps compressed; the trace carpet retains raw elapsed time.'
    : 'Raw calibrated elapsed time; distances are linear and may produce dense activity clusters.'

const render = (): void => {
  if (artifact === undefined) return
  const trace = artifact.trace
  captureEventlogScrollState()
  const projected = projectTraceAt({ scenario: artifact.scenario, trace, cursorIndex })
  const record = cursorIndex < 0 ? undefined : trace[cursorIndex]
  const selectedMoment = playbackMoments.find((moment) => moment.recordIndex === cursorIndex)
  const momentPosition = playbackMoments.findLastIndex((moment) => moment.recordIndex <= cursorIndex) + 1
  const recordPosition = cursorIndex < 0 ? 0 : cursorIndex + 1

  cursorLabel.textContent =
    playbackMode === 'moments'
      ? `${momentPosition} / ${playbackMoments.length} moments · ${recordPosition} / ${artifact.trace.length} records`
      : `${recordPosition} / ${artifact.trace.length} records`
  recordLabel.textContent =
    playbackMode === 'moments' && selectedMoment !== undefined
      ? selectedMoment.label
      : (record?.payload._tag ?? 'No observation applied')
  recordDetails.textContent =
    record === undefined
      ? 'No trace record selected.'
      : selectedMoment !== undefined && selectedMoment.recordIndexes.length > 1
        ? JSON.stringify(
            {
              moment: selectedMoment,
              records: selectedMoment.recordIndexes.map((index) => trace[index]),
            },
            null,
            2,
          )
        : JSON.stringify(record, null, 2)
  runStatus.textContent = projected.runStatus
  runStatus.className = `badge ${statusTone(projected.runStatus)}`
  systemState.className = 'topology'
  systemState.innerHTML = renderTopology(projected)
  restoreEventlogScrollState()
  renderTimeline()
  bindEventSelection()
  bindTimelineScrubber()
  bindRangeNavigator()
}

const renderTopology = (state: ReturnType<typeof projectTraceAt>): string => {
  const backend = state.backend
  const backendCard = `
    <article class="component-card" style="--component-color:#4169e1">
      <div class="component-title">
        <h3>Sync backend</h3>
        <span class="badge ${backend?.connected === true ? 'good' : backend === null ? 'neutral' : 'bad'}">${backend === null ? 'unobserved' : backend.connected === true ? 'online' : 'offline'}</span>
      </div>
      ${renderEventlog('backend', backend?.events ?? [], backend === null ? 'No backend observation yet' : `Authoritative head ${backend.head}`)}
    </article>`

  const clientCards = state.clients
    .map((client, index) => {
      const color = clientColor(index)
      const badge = client.connected === false ? ['offline', 'bad'] : syncBadge(client.leader)
      return `
        <article class="component-card" style="--component-color:${color}">
          <div class="component-title">
            <h3>${escapeMarkup(client.clientId)}</h3>
            <span class="badge ${badge[1]}">${badge[0]}</span>
          </div>
          ${renderEventlog(`client:${client.clientId}`, client.leader?.events ?? [], client.leader === null ? 'Leader not observed' : `Client eventlog · ${client.leader.pendingCount} pending`)}
          <div class="role-list">
            ${renderRole('Leader role', client.leader)}
            ${client.sessions.map((session) => renderRole(`Session ${session.sessionId}`, session.sync)).join('')}
          </div>
        </article>`
    })
    .join('')

  return `${backendCard}${clientCards}`
}

const renderEventlog = (key: string, events: ReadonlyArray<ObservedEvent>, label: string): string => `
  <div class="eventlog-block">
    <p class="eyebrow">${escapeMarkup(label)}</p>
    <div class="eventlog" data-eventlog-key="${escapeMarkup(key)}" aria-label="${escapeMarkup(label)}">
      <div class="eventlog-track">
        ${
          events.length === 0
            ? '<span class="summary">No events observed</span>'
            : events
                .map(
                  (event) => `
                    <button
                      type="button"
                      class="event-chip ${event.disposition} ${event.eventRef === selectedEventRef ? 'selected' : ''}"
                      data-event-ref="${escapeMarkup(event.eventRef)}"
                      title="${escapeMarkup(`${event.name} · ${event.eventRef}`)}"
                    >${escapeMarkup(event.position)}</button>`,
                )
                .join('')
        }
      </div>
    </div>
  </div>`

const renderRole = (label: string, sync: ComponentSyncObservation | null): string => `
  <div class="role-row">
    <strong>${escapeMarkup(label)}</strong>
    <span>${
      sync === null
        ? 'not observed'
        : `local ${escapeMarkup(sync.localHead)} · upstream ${escapeMarkup(sync.upstreamHead)} · ${sync.pendingCount} pending`
    }</span>
  </div>`

const renderTimeline = (): void => {
  if (artifact === undefined) return
  const trace = artifact.trace
  const markers = deriveEventTimeline(trace)
  const captures = deriveTraceCaptures(trace)
  const systemCaptureIds = new Set(
    playbackMoments.flatMap((moment) => (moment.captureId === null ? [] : [moment.captureId])),
  )
  const lanes: ReadonlyArray<TimelineLane> = [
    { key: backendComponentKey, label: 'Backend', color: '#4169e1', role: 'backend' },
    ...artifact.scenario.topology.clients.flatMap((client, index) => [
      {
        key: leaderComponentKey(client.id),
        label: `${client.id} · Leader`,
        color: clientColor(index),
        role: 'leader' as const,
      },
      ...client.sessions.map((sessionId) => ({
        key: sessionComponentKey(client.id, sessionId),
        label: sessionId,
        color: clientColor(index),
        role: 'session' as const,
      })),
    ]),
  ]
  const laneIndex = new Map(lanes.map((lane, index) => [lane.key, index]))
  const width = 1400
  const left = 180
  const right = 35
  const laneHeight = 62
  const carpetTop = lanes.length * laneHeight + 36
  const height = carpetTop + 54
  const plotWidth = width - left - right
  const yAt = (key: string): number => (laneIndex.get(key) ?? 0) * laneHeight + 30
  const projectionUnits = new Map<string, number>()
  const unitByRecord = new Map<number, number>()
  for (const record of artifact.trace) {
    const key = record.captureId === null ? `record:${record.index}` : `capture:${record.captureId}`
    let unit = projectionUnits.get(key)
    if (unit === undefined) {
      unit = projectionUnits.size
      projectionUnits.set(key, unit)
    }
    unitByRecord.set(record.index, unit)
  }
  const flowMax = Math.max(projectionUnits.size - 1, 1)
  const recordTimes = artifact.trace.map((record) =>
    record.calibratedTime === null
      ? record.coordinatorReceiptMonotonicMs
      : (record.calibratedTime.earliestMs + record.calibratedTime.latestMs) / 2,
  )
  const timeMin = Math.min(
    ...artifact.trace.map((record) => record.calibratedTime?.earliestMs ?? record.coordinatorReceiptMonotonicMs),
    0,
  )
  const timeMax = Math.max(
    ...artifact.trace.map((record) => record.calibratedTime?.latestMs ?? record.coordinatorReceiptMonotonicMs),
    timeMin + 1,
  )
  const adaptiveTimeLayout = deriveAdaptiveTimeLayout([timeMin, ...recordTimes, timeMax])
  const normalizedRawTime = (time: number): number => (time - timeMin) / (timeMax - timeMin)
  const normalizedFittedTime = (time: number): number => projectAdaptiveTime(adaptiveTimeLayout, time)
  const normalizedForRecord = (recordIndex: number): number => {
    if (timelineMode === 'flow') return (unitByRecord.get(recordIndex) ?? 0) / flowMax
    const time = recordTimes[recordIndex] ?? timeMin
    return timeScaleMode === 'fit' ? normalizedFittedTime(time) : normalizedRawTime(time)
  }
  const viewportSpan = timelineViewport.end - timelineViewport.start
  const xForNormalized = (position: number): number =>
    left + ((position - timelineViewport.start) / viewportSpan) * plotWidth
  const overviewXForNormalized = (position: number): number => left + position * plotWidth
  const isVisibleNormalized = (position: number): boolean =>
    position >= timelineViewport.start && position <= timelineViewport.end
  const isVisibleRecord = (recordIndex: number): boolean => isVisibleNormalized(normalizedForRecord(recordIndex))
  const rawOverviewXForTime = (time: number): number => overviewXForNormalized(normalizedRawTime(time))
  const xForTime = (time: number): number =>
    xForNormalized(timeScaleMode === 'fit' ? normalizedFittedTime(time) : normalizedRawTime(time))
  const xForRecord = (recordIndex: number): number => {
    return xForNormalized(normalizedForRecord(recordIndex))
  }
  const xForCarpetRecord = (recordIndex: number): number =>
    timelineMode === 'time' && timeScaleMode === 'fit'
      ? rawOverviewXForTime(recordTimes[recordIndex] ?? timeMin)
      : xForRecord(recordIndex)
  const scrubRecordIndexes =
    traceVisibility === 'system'
      ? playbackMoments.map((moment) => moment.recordIndex)
      : artifact.trace.map((record) => record.index)
  timelineRecordPositions = scrubRecordIndexes.filter(isVisibleRecord).map((index) => ({ index, x: xForRecord(index) }))

  const positionedByLane = new Map(
    [...Map.groupBy(markers, (marker) => marker.componentKey)].map(([componentKey, laneMarkers]) => [
      componentKey,
      laneMarkers
        .filter((marker) => isVisibleRecord(marker.recordIndex))
        .map((marker) => ({ marker, x: xForRecord(marker.recordIndex) }))
        .toSorted((left, right) => left.x - right.x),
    ]),
  )
  const maximumLaneMarkerCount = Math.max(0, ...[...positionedByLane.values()].map((laneMarkers) => laneMarkers.length))
  const averageMarkerSpacing = maximumLaneMarkerCount === 0 ? plotWidth : plotWidth / maximumLaneMarkerCount
  const markerMode = averageMarkerSpacing >= 54 ? 'label' : averageMarkerSpacing >= 7 ? 'point' : 'aggregate'

  const markerSvg = [...positionedByLane.values()]
    .flatMap((laneMarkers) => {
      if (markerMode === 'label') return laneMarkers.map((positioned) => [positioned])
      return groupMarkersIntoBins({ markers: laneMarkers, left, binWidth: markerMode === 'point' ? 7 : 14 })
    })
    .map((group) => {
      const first = group[0]!
      const selected = group.some(({ marker }) => marker.event.eventRef === selectedEventRef) === true ? 'selected' : ''
      const pending = group.some(({ marker }) => marker.event.disposition === 'pending') === true ? 'pending' : ''
      const future = group.every(({ marker }) => marker.recordIndex > cursorIndex) === true ? 'future' : ''
      const recordIndex = Math.max(...group.map(({ marker }) => marker.recordIndex))
      const x = group.reduce((total, item) => total + item.x, 0) / group.length
      const y = yAt(first.marker.componentKey)
      const title = escapeMarkup(markerGroupTitle(group))
      const eventRef = group.length === 1 ? `data-event-ref="${escapeMarkup(first.marker.event.eventRef)}"` : ''

      if (markerMode === 'label') {
        const marker = first.marker
        const uncertainty =
          timelineMode === 'time' &&
          marker.calibratedTime !== null &&
          marker.calibratedTime.latestMs > marker.calibratedTime.earliestMs
            ? `<line class="time-uncertainty" x1="${xForTime(marker.calibratedTime.earliestMs) - (x - 24)}" x2="${xForTime(marker.calibratedTime.latestMs) - (x - 24)}" y1="10" y2="10" />`
            : ''
        return `
          <g
            class="marker marker-label ${pending} ${selected} ${future}"
            ${eventRef}
            data-record-index="${recordIndex}"
            transform="translate(${x - 24} ${y - 10})"
          >
            <title>${title}</title>
            ${uncertainty}
            <rect width="48" height="20" rx="3" />
            <text x="24" y="14" text-anchor="middle">${escapeMarkup(marker.event.position)}</text>
          </g>`
      }

      const radius = group.length === 1 ? 3.8 : Math.min(8, 3.8 + Math.log2(group.length))
      return `
        <g
          class="marker event-point ${markerMode} ${pending} ${selected} ${future}"
          ${eventRef}
          data-record-index="${recordIndex}"
        >
          <title>${title}</title>
          <circle cx="${x}" cy="${y}" r="${radius}" />
          ${group.length > 1 && radius >= 5.8 ? `<text x="${x}" y="${y + 2.3}" text-anchor="middle">${group.length}</text>` : ''}
        </g>`
    })
    .join('')

  const compressedGaps =
    timelineMode === 'time' && timeScaleMode === 'fit'
      ? adaptiveTimeLayout.compressedGaps
          .filter(
            (gap) =>
              gap.endPosition >= timelineViewport.start &&
              gap.startPosition <= timelineViewport.end &&
              ((Math.min(gap.endPosition, timelineViewport.end) - Math.max(gap.startPosition, timelineViewport.start)) /
                viewportSpan) *
                plotWidth >=
                38,
          )
          .map((gap) => {
            const x1 = xForNormalized(Math.max(gap.startPosition, timelineViewport.start))
            const x2 = xForNormalized(Math.min(gap.endPosition, timelineViewport.end))
            const midpoint = (x1 + x2) / 2
            return `
              <rect class="compressed-gap-band" x="${x1}" y="3" width="${x2 - x1}" height="${carpetTop - 11}" />
              <line class="compressed-gap-edge" x1="${x1}" x2="${x1}" y1="3" y2="${carpetTop - 8}" />
              <line class="compressed-gap-edge" x1="${x2}" x2="${x2}" y1="3" y2="${carpetTop - 8}" />
              <text class="compressed-gap-label" x="${midpoint}" y="11" text-anchor="middle">// ${formatDuration(gap.durationMs)} //</text>`
          })
          .join('')
      : ''

  const captureGuides = captures
    .filter(
      (capture) =>
        (traceVisibility === 'all' || systemCaptureIds.has(capture.captureId)) &&
        isVisibleRecord(traceVisibility === 'system' ? capture.lastRecordIndex : capture.firstRecordIndex),
    )
    .map((capture) => {
      const x = xForRecord(traceVisibility === 'system' ? capture.lastRecordIndex : capture.firstRecordIndex)
      return `<line class="capture-guide" x1="${x}" x2="${x}" y1="12" y2="${carpetTop - 8}"><title>capture ${capture.captureIndex + 1} · non-atomic sampling pass</title></line>`
    })
    .join('')

  const captureStack = new Map<string, number>()
  const traceCarpet =
    traceVisibility === 'system'
      ? playbackMoments
          .filter(
            (moment) => (timelineMode === 'time' && timeScaleMode === 'fit') || isVisibleRecord(moment.recordIndex),
          )
          .map((moment) => {
            const record = trace[moment.recordIndex]!
            return `<circle
              class="trace-dot system-moment ${record.evidence} ${moment.recordIndexes.includes(cursorIndex) === true ? 'selected' : ''}"
              data-record-index="${moment.recordIndex}"
              cx="${xForCarpetRecord(moment.recordIndex)}"
              cy="${carpetTop + 15}"
              r="3.2"
            ><title>moment ${moment.momentIndex + 1} · ${escapeMarkup(moment.label)} · record ${moment.recordIndex + 1}</title></circle>`
          })
          .join('')
      : artifact.trace
          .filter((record) => (timelineMode === 'time' && timeScaleMode === 'fit') || isVisibleRecord(record.index))
          .map((record) => {
            const stack = record.captureId === null ? 0 : (captureStack.get(record.captureId) ?? 0)
            if (record.captureId !== null) captureStack.set(record.captureId, stack + 1)
            const y = carpetTop + 15 + (stack % 4) * 7
            return `<circle
              class="trace-dot ${record.evidence} ${record.index === cursorIndex ? 'selected' : ''}"
              data-record-index="${record.index}"
              cx="${xForCarpetRecord(record.index)}"
              cy="${y}"
              r="2.8"
            ><title>#${record.index + 1} · ${escapeMarkup(record.payload._tag)} · ${escapeMarkup(record.evidence)}</title></circle>`
          })
          .join('')

  const hierarchySvg = artifact.scenario.topology.clients
    .map((client) => {
      if (client.sessions.length === 0) return ''
      const leaderY = yAt(leaderComponentKey(client.id))
      const sessionYs = client.sessions.map((sessionId) => yAt(sessionComponentKey(client.id, sessionId)))
      const connectorX = 19
      const branchEndX = 30
      return `
        <path class="lane-hierarchy" d="M ${connectorX} ${leaderY + 11} V ${sessionYs.at(-1)!}" />
        ${sessionYs.map((sessionY) => `<path class="lane-hierarchy" d="M ${connectorX} ${sessionY} H ${branchEndX}" />`).join('')}`
    })
    .join('')

  const lanesSvg = lanes
    .map(
      (lane) => `
        <text class="lane-label ${lane.role}" x="${lane.role === 'session' ? 36 : 8}" y="${yAt(lane.key) + 4}">${escapeMarkup(lane.label)}</text>
        <line x1="${left}" x2="${width - right}" y1="${yAt(lane.key)}" y2="${yAt(lane.key)}" stroke="${lane.color}" stroke-width="2" />`,
    )
    .join('')

  const densityBinCount = 160
  const densityBins = Array.from({ length: densityBinCount }, () => 0)
  for (const marker of markers) {
    const bin = Math.min(Math.floor(normalizedForRecord(marker.recordIndex) * densityBinCount), densityBinCount - 1)
    densityBins[bin] = (densityBins[bin] ?? 0) + 1
  }
  const maximumDensity = Math.max(1, ...densityBins)
  const navigatorDensity = densityBins
    .map((count, index) => {
      if (count === 0) return ''
      const barWidth = plotWidth / densityBinCount
      const barHeight = 3 + (Math.log1p(count) / Math.log1p(maximumDensity)) * 18
      return `<rect class="range-density-bar" x="${left + index * barWidth}" y="${34 - barHeight}" width="${Math.max(barWidth - 0.6, 0.8)}" height="${barHeight}" />`
    })
    .join('')
  const rangeStartX = overviewXForNormalized(timelineViewport.start)
  const rangeEndX = overviewXForNormalized(timelineViewport.end)
  const rangeWidth = rangeEndX - rangeStartX
  const rangeSummary =
    timelineViewport.start === 0 && timelineViewport.end === 1
      ? 'full run'
      : `${Math.round(timelineViewport.start * 100)}–${Math.round(timelineViewport.end * 100)}%`
  const overviewCursorX = cursorIndex < 0 ? undefined : overviewXForNormalized(normalizedForRecord(cursorIndex))
  const mainCursorVisible = cursorIndex >= 0 && isVisibleRecord(cursorIndex)

  timeline.className = 'timeline'
  timeline.innerHTML = `
    <svg
      class="timeline-main"
      viewBox="0 0 ${width} ${height}"
      role="slider"
      tabindex="0"
      aria-label="Trace cursor"
      aria-valuemin="0"
      aria-valuemax="${artifact.trace.length - 1}"
      aria-valuenow="${Math.max(cursorIndex, 0)}"
      aria-valuetext="${escapeMarkup(recordLabel.textContent ?? '')}"
    >
      ${compressedGaps}
      ${hierarchySvg}
      ${lanesSvg}
      ${captureGuides}
      ${markerSvg}
      <text class="trace-carpet-label" x="8" y="${carpetTop + 18}">${traceVisibility === 'system' ? 'SYSTEM' : 'TRACE'}${timelineMode === 'time' && timeScaleMode === 'fit' ? ' · RAW TIME' : ''}</text>
      ${traceCarpet}
      <g class="cursor-scrubber" aria-hidden="true">
        ${
          mainCursorVisible === true
            ? `<line class="cursor-line" x1="${xForRecord(cursorIndex)}" x2="${xForRecord(cursorIndex)}" y1="10" y2="${timelineMode === 'time' && timeScaleMode === 'fit' ? carpetTop - 8 : height - 10}" />
               <circle class="cursor-handle" cx="${xForRecord(cursorIndex)}" cy="9" r="6" />`
            : ''
        }
        ${
          cursorIndex >= 0 && timelineMode === 'time' && timeScaleMode === 'fit'
            ? `<line class="carpet-cursor" x1="${xForCarpetRecord(cursorIndex)}" x2="${xForCarpetRecord(cursorIndex)}" y1="${carpetTop + 5}" y2="${height - 7}" />`
            : ''
        }
      </g>
    </svg>
    <svg
      class="range-navigator"
      viewBox="0 0 ${width} 44"
      role="group"
      tabindex="0"
      aria-label="Timeline visible range"
      data-range-navigator
    >
      <text class="range-label" x="8" y="26">RANGE</text>
      <text class="range-summary" x="${width - right}" y="10" text-anchor="end">${rangeSummary}</text>
      <rect class="range-track" x="${left}" y="7" width="${plotWidth}" height="28" rx="2" data-range-action="track" />
      ${navigatorDensity}
      <rect
        class="range-window"
        x="${rangeStartX}"
        y="5"
        width="${rangeWidth}"
        height="32"
        rx="2"
        data-range-action="window"
      ><title>Drag to pan the visible timeline range</title></rect>
      <g class="range-handle start" data-range-action="start">
        <rect class="range-handle-hit" x="${rangeStartX - 7}" y="2" width="14" height="38" />
        <line x1="${rangeStartX}" x2="${rangeStartX}" y1="3" y2="39" />
      </g>
      <g class="range-handle end" data-range-action="end">
        <rect class="range-handle-hit" x="${rangeEndX - 7}" y="2" width="14" height="38" />
        <line x1="${rangeEndX}" x2="${rangeEndX}" y1="3" y2="39" />
      </g>
      ${
        overviewCursorX === undefined
          ? ''
          : `<line class="range-cursor" x1="${overviewCursorX}" x2="${overviewCursorX}" y1="4" y2="39"><title>Current trace cursor</title></line>`
      }
    </svg>`
}

const bindEventSelection = (): void => {
  systemState.querySelectorAll<HTMLElement>('[data-event-ref]').forEach((element) => {
    element.addEventListener('click', () => {
      selectedEventRef = element.dataset.eventRef
      eventSelection.textContent = selectedEventRef === undefined ? '' : `Highlighting ${selectedEventRef}`
      render()
    })
  })
}

const bindTimelineScrubber = (): void => {
  if (artifact === undefined) return
  const svg = timeline.querySelector<SVGSVGElement>('svg.timeline-main')
  if (svg === null) return

  const viewBoxWidth = 1400

  const moveCursor = (clientX: number, bounds: DOMRect): void => {
    if (timelineRecordPositions.length === 0) return
    const svgX = ((clientX - bounds.left) / bounds.width) * viewBoxWidth
    const closest = timelineRecordPositions.reduce((candidate, position) =>
      Math.abs(position.x - svgX) < Math.abs(candidate.x - svgX) ? position : candidate,
    )
    const nextCursor = closest.index
    if (nextCursor === cursorIndex) return
    stopPlayback()
    cursorIndex = nextCursor
    render()
  }

  svg.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    const bounds = svg.getBoundingClientRect()
    const pointerId = event.pointerId
    const startX = event.clientX
    const target = event.target instanceof Element ? event.target : undefined
    const eventTarget = target?.closest<SVGElement>('[data-event-ref]')
    const recordTarget = target?.closest<SVGElement>('[data-record-index]')
    const startsOnMarker =
      (eventTarget !== null && eventTarget !== undefined) || (recordTarget !== null && recordTarget !== undefined)
    let scrubbing = startsOnMarker === false
    if (scrubbing === true) moveCursor(event.clientX, bounds)

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId || moveEvent.buttons !== 1) return
      if (scrubbing === false && Math.abs(moveEvent.clientX - startX) >= 4) scrubbing = true
      if (scrubbing === false) return
      moveCursor(moveEvent.clientX, bounds)
    }
    const onPointerUp = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      if (scrubbing === true) {
        moveCursor(endEvent.clientX, bounds)
        return
      }
      const eventRef = eventTarget?.dataset.eventRef
      if (eventRef !== undefined) {
        selectedEventRef = eventRef
        eventSelection.textContent = `Highlighting ${eventRef}`
        render()
        return
      }
      const nextCursor = Number(recordTarget?.dataset.recordIndex)
      if (Number.isInteger(nextCursor) === false) return
      stopPlayback()
      cursorIndex = nextCursor
      render()
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  })

  svg.addEventListener('keydown', (event) => {
    const indexes = playbackCursorIndexes()
    const nextCursor =
      event.key === 'ArrowLeft'
        ? indexes.findLast((index) => index < cursorIndex)
        : event.key === 'ArrowRight'
          ? indexes.find((index) => index > cursorIndex)
          : event.key === 'Home'
            ? indexes[0]
            : event.key === 'End'
              ? indexes.at(-1)
              : undefined
    if (nextCursor === undefined) return
    event.preventDefault()
    stopPlayback()
    cursorIndex = nextCursor
    render()
    timeline.querySelector<SVGSVGElement>('svg.timeline-main')?.focus()
  })
}

const bindRangeNavigator = (): void => {
  const navigator = timeline.querySelector<SVGSVGElement>('[data-range-navigator]')
  if (navigator === null) return

  const viewBoxWidth = 1400
  const plotLeft = 180
  const plotRight = 35
  const plotWidth = viewBoxWidth - plotLeft - plotRight
  const positionAt = (clientX: number, bounds: DOMRect): number =>
    clamp((((clientX - bounds.left) / bounds.width) * viewBoxWidth - plotLeft) / plotWidth, 0, 1)

  navigator.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-range-action]') : null
    const action = target?.dataset.rangeAction
    if (action === undefined) return
    event.preventDefault()

    const bounds = navigator.getBoundingClientRect()
    const pointerId = event.pointerId
    const pointerStart = positionAt(event.clientX, bounds)
    const viewportStart = timelineViewport.start
    const viewportEnd = timelineViewport.end
    const viewportSpan = viewportEnd - viewportStart

    if (action === 'track') {
      setTimelineViewport(pointerStart - viewportSpan / 2, pointerStart + viewportSpan / 2)
      render()
      return
    }

    const updateRange = (clientX: number): void => {
      const position = positionAt(clientX, bounds)
      if (action === 'start') {
        setTimelineViewport(Math.min(position, viewportEnd - 0.01), viewportEnd)
      } else if (action === 'end') {
        setTimelineViewport(viewportStart, Math.max(position, viewportStart + 0.01))
      } else {
        const delta = position - pointerStart
        setTimelineViewport(viewportStart + delta, viewportEnd + delta)
      }
      render()
    }

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId || moveEvent.buttons !== 1) return
      updateRange(moveEvent.clientX)
    }
    const onPointerUp = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      updateRange(endEvent.clientX)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  })

  navigator.addEventListener('keydown', (event) => {
    const span = timelineViewport.end - timelineViewport.start
    const midpoint = (timelineViewport.start + timelineViewport.end) / 2
    if (event.key === 'Home') {
      timelineViewport = { start: 0, end: 1 }
    } else if (event.key === '+' || event.key === '=') {
      const nextSpan = span * 0.75
      setTimelineViewport(midpoint - nextSpan / 2, midpoint + nextSpan / 2)
    } else if (event.key === '-') {
      const nextSpan = Math.min(span / 0.75, 1)
      setTimelineViewport(midpoint - nextSpan / 2, midpoint + nextSpan / 2)
    } else if (event.key === 'ArrowLeft') {
      setTimelineViewport(timelineViewport.start - span * 0.1, timelineViewport.end - span * 0.1)
    } else if (event.key === 'ArrowRight') {
      setTimelineViewport(timelineViewport.start + span * 0.1, timelineViewport.end + span * 0.1)
    } else {
      return
    }
    event.preventDefault()
    render()
    timeline.querySelector<SVGSVGElement>('[data-range-navigator]')?.focus()
  })
}

/** Keeps the overview brush ordered, bounded, and large enough to remain operable. */
const setTimelineViewport = (requestedStart: number, requestedEnd: number): void => {
  const minimumSpan = 0.01
  const requestedSpan = requestedEnd - requestedStart
  const span = clamp(requestedSpan, minimumSpan, 1)
  let start = requestedStart
  if (requestedSpan < minimumSpan) start = (requestedStart + requestedEnd) / 2 - span / 2
  start = clamp(start, 0, 1 - span)
  timelineViewport = { start, end: start + span }
}

const captureEventlogScrollState = (): void => {
  systemState.querySelectorAll<HTMLElement>('[data-eventlog-key]').forEach((element) => {
    const key = element.dataset.eventlogKey
    if (key === undefined) return
    const maximumScrollLeft = Math.max(element.scrollWidth - element.clientWidth, 0)
    eventlogScrollStates.set(key, {
      followTail: maximumScrollLeft - element.scrollLeft <= 2,
      scrollLeft: element.scrollLeft,
    })
  })
}

const restoreEventlogScrollState = (): void => {
  systemState.querySelectorAll<HTMLElement>('[data-eventlog-key]').forEach((element) => {
    const key = element.dataset.eventlogKey
    if (key === undefined) return
    const state = eventlogScrollStates.get(key) ?? { followTail: true, scrollLeft: 0 }
    const maximumScrollLeft = Math.max(element.scrollWidth - element.clientWidth, 0)
    element.scrollLeft = state.followTail === true ? maximumScrollLeft : Math.min(state.scrollLeft, maximumScrollLeft)
    eventlogScrollStates.set(key, { followTail: state.followTail, scrollLeft: element.scrollLeft })

    let restoring = true
    window.requestAnimationFrame(() => {
      restoring = false
    })
    element.addEventListener(
      'scroll',
      () => {
        if (restoring === true) return
        const nextMaximumScrollLeft = Math.max(element.scrollWidth - element.clientWidth, 0)
        eventlogScrollStates.set(key, {
          followTail: nextMaximumScrollLeft - element.scrollLeft <= 2,
          scrollLeft: element.scrollLeft,
        })
      },
      { passive: true },
    )
  })
}

/** Groups only markers that occupy the same visual bin; adjacency cannot transitively merge a whole lane. */
const groupMarkersIntoBins = ({
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
  return [...bins.entries()].toSorted(([leftBin], [rightBin]) => leftBin - rightBin).map(([, group]) => group)
}

const markerGroupTitle = (group: ReadonlyArray<PositionedTimelineMarker>): string => {
  if (group.length === 1) {
    const marker = group[0]!.marker
    return `${marker.event.name} · ${marker.event.eventRef} · ${marker.event.position} · observed change in capture ${marker.captureIndex + 1}`
  }
  const visibleItems = group
    .slice(0, 8)
    .map(({ marker }) => `${marker.event.position} · ${marker.event.name} · ${marker.event.eventRef}`)
    .join('\n')
  const remainder = group.length > 8 ? `\n… ${group.length - 8} more` : ''
  return `${group.length} observed event changes\n${visibleItems}${remainder}`
}

const syncBadge = (sync: ComponentSyncObservation | null): readonly [string, string] => {
  if (sync === null) return ['unobserved', 'neutral']
  if (sync.pendingCount > 0) return [`${sync.pendingCount} pending`, 'warn']
  if (globalPosition(sync.localHead) !== globalPosition(sync.upstreamHead)) return ['catching up', 'warn']
  return ['synced', 'good']
}

const globalPosition = (head: string): number => Number(head.match(/^e(\d+)/)?.[1] ?? -1)

const statusTone = (status: string): string => {
  if (status === 'passed') return 'good'
  if (status === 'failed') return 'bad'
  if (status === 'running') return 'warn'
  return 'neutral'
}

const clientColor = (index: number): string => ['#088361', '#d8662c', '#9c3cc0', '#08759c'][index % 4]!

const formatDuration = (durationMs: number): string =>
  durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 1 : 2)}s` : `${Math.round(durationMs)}ms`

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(Math.max(value, minimum), maximum)

const escapeMarkup = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
