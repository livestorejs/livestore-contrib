import { Schema } from '@livestore/utils/effect'

import { type ComponentSyncObservation, type ObservedEvent, ScenarioRunArtifact } from '../model.ts'
import {
  backendComponentKey,
  deriveEventTimeline,
  deriveTraceCaptures,
  leaderComponentKey,
  projectTraceAt,
  sessionComponentKey,
} from '../projection.ts'
import './style.css'

const requireElement = <T extends typeof Element>(id: string, constructor: T): InstanceType<T> => {
  const element = document.getElementById(id)
  if (element === null || element instanceof constructor === false) throw new Error(`Missing #${id}`)
  return element as InstanceType<T>
}

const fileInput = requireElement('artifact-file', HTMLInputElement)
const loadDefaultButton = requireElement('load-default', HTMLButtonElement)
const playButton = requireElement('play', HTMLButtonElement)
const runTitle = requireElement('run-title', HTMLElement)
const runSummary = requireElement('run-summary', HTMLElement)
const traceName = requireElement('trace-name', HTMLElement)
const cursorLabel = requireElement('cursor-label', HTMLElement)
const recordLabel = requireElement('record-label', HTMLElement)
const modeFlowButton = requireElement('mode-flow', HTMLButtonElement)
const modeTimeButton = requireElement('mode-time', HTMLButtonElement)
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
let timelineRecordPositions: ReadonlyArray<number> = []

modeFlowButton.addEventListener('click', () => setTimelineMode('flow'))
modeTimeButton.addEventListener('click', () => setTimelineMode('time'))

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file === undefined) return
  void file.text().then(loadArtifactJson).catch(showLoadError)
})

loadDefaultButton.addEventListener('click', () => {
  void fetch('/offline-writer-recovery.json')
    .then(async (response) => {
      if (response.ok === false) throw new Error('Run the scenario:run command before loading the generated artifact.')
      return response.text()
    })
    .then(loadArtifactJson)
    .catch(showLoadError)
})

playButton.addEventListener('click', () => {
  if (playTimer !== undefined) {
    stopPlayback()
    return
  }
  if (artifact === undefined) return
  if (cursorIndex >= artifact.trace.length - 1) cursorIndex = -1
  playButton.textContent = 'pause'
  playTimer = window.setInterval(() => {
    if (artifact === undefined || cursorIndex >= artifact.trace.length - 1) {
      stopPlayback()
      return
    }
    cursorIndex += 1
    render()
  }, 180)
})

const loadArtifactJson = (input: string): void => {
  stopPlayback()
  artifact = Schema.decodeUnknownSync(Schema.fromJsonString(ScenarioRunArtifact))(input)
  cursorIndex = artifact.trace.length - 1
  selectedEventRef = undefined
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
  modeFlowButton.setAttribute('aria-pressed', String(mode === 'flow'))
  modeTimeButton.setAttribute('aria-pressed', String(mode === 'time'))
  timelineModeNote.textContent =
    mode === 'flow'
      ? 'Observation captures are aligned; no causal arrows are inferred.'
      : 'Position uses calibrated evidence time; current sampled observations use controller receipt time.'
  render()
}

const render = (): void => {
  if (artifact === undefined) return
  const projected = projectTraceAt({ scenario: artifact.scenario, trace: artifact.trace, cursorIndex })
  const record = cursorIndex < 0 ? undefined : artifact.trace[cursorIndex]

  cursorLabel.textContent =
    cursorIndex < 0 ? `0 / ${artifact.trace.length}` : `${cursorIndex + 1} / ${artifact.trace.length}`
  recordLabel.textContent = record?.payload._tag ?? 'No observation applied'
  recordDetails.textContent = record === undefined ? 'No trace record selected.' : JSON.stringify(record, null, 2)
  runStatus.textContent = projected.runStatus
  runStatus.className = `badge ${statusTone(projected.runStatus)}`
  systemState.className = 'topology'
  systemState.innerHTML = renderTopology(projected)
  renderTimeline()
  bindEventSelection()
  bindTraceSelection()
  bindTimelineScrubber()
}

const renderTopology = (state: ReturnType<typeof projectTraceAt>): string => {
  const backend = state.backend
  const backendCard = `
    <article class="component-card" style="--component-color:#4169e1">
      <div class="component-title">
        <h3>Sync backend</h3>
        <span class="badge ${backend?.connected === true ? 'good' : backend === null ? 'neutral' : 'bad'}">${backend === null ? 'unobserved' : backend.connected === true ? 'online' : 'offline'}</span>
      </div>
      ${renderEventlog(backend?.events ?? [], backend === null ? 'No backend observation yet' : `Authoritative head ${backend.head}`)}
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
          ${renderEventlog(client.leader?.events ?? [], client.leader === null ? 'Leader not observed' : `Client eventlog · ${client.leader.pendingCount} pending`)}
          <div class="role-list">
            ${renderRole('Leader role', client.leader)}
            ${client.sessions.map((session) => renderRole(`Session ${session.sessionId}`, session.sync)).join('')}
          </div>
        </article>`
    })
    .join('')

  return `${backendCard}${clientCards}`
}

const renderEventlog = (events: ReadonlyArray<ObservedEvent>, label: string): string => `
  <div>
    <p class="eyebrow">${escapeMarkup(label)}</p>
    <div class="eventlog">
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
  const markers = deriveEventTimeline(artifact.trace)
  const captures = deriveTraceCaptures(artifact.trace)
  const lanes = [
    { key: backendComponentKey, label: 'Backend', color: '#4169e1' },
    ...artifact.scenario.topology.clients.flatMap((client, index) => [
      { key: leaderComponentKey(client.id), label: `${client.id} · Leader`, color: clientColor(index) },
      ...client.sessions.map((sessionId) => ({
        key: sessionComponentKey(client.id, sessionId),
        label: `${client.id} · ${sessionId}`,
        color: clientColor(index),
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
  const xForTime = (time: number): number => left + ((time - timeMin) / (timeMax - timeMin)) * plotWidth
  const xForRecord = (recordIndex: number): number => {
    if (timelineMode === 'flow') return left + ((unitByRecord.get(recordIndex) ?? 0) / flowMax) * plotWidth
    const time = recordTimes[recordIndex] ?? timeMin
    return xForTime(time)
  }
  timelineRecordPositions = artifact.trace.map((record) => xForRecord(record.index))

  const markerStacks = new Map<string, number>()

  const markerSvg = markers
    .map((marker) => {
      const selected = marker.event.eventRef === selectedEventRef ? 'selected' : ''
      const future = marker.recordIndex > cursorIndex ? 'opacity="0.22"' : ''
      const stackKey = `${marker.componentKey}\u0000${marker.captureId}`
      const stack = markerStacks.get(stackKey) ?? 0
      markerStacks.set(stackKey, stack + 1)
      const markerY = yAt(marker.componentKey) - 10 + stack * 7
      const uncertainty =
        timelineMode === 'time' &&
        marker.calibratedTime !== null &&
        marker.calibratedTime.latestMs > marker.calibratedTime.earliestMs
          ? `<line class="time-uncertainty" x1="${xForTime(marker.calibratedTime.earliestMs)}" x2="${xForTime(marker.calibratedTime.latestMs)}" y1="${markerY + 10}" y2="${markerY + 10}" />`
          : ''
      return `
        ${uncertainty}
        <g
          class="marker ${marker.event.disposition} ${selected}"
          data-event-ref="${escapeMarkup(marker.event.eventRef)}"
          transform="translate(${xForRecord(marker.recordIndex) - 24} ${markerY})"
          ${future}
        >
          <title>${escapeMarkup(`${marker.event.name} · ${marker.event.eventRef} · first observed in capture ${marker.captureIndex + 1}`)}</title>
          <rect width="48" height="20" rx="3" />
          <text x="24" y="14" text-anchor="middle">${escapeMarkup(marker.event.position)}</text>
        </g>`
    })
    .join('')

  const captureGuides = captures
    .map((capture) => {
      const x = xForRecord(capture.firstRecordIndex)
      return `<line class="capture-guide" x1="${x}" x2="${x}" y1="12" y2="${carpetTop - 8}"><title>capture ${capture.captureIndex + 1} · non-atomic sampling pass</title></line>`
    })
    .join('')

  const captureStack = new Map<string, number>()
  const traceCarpet = artifact.trace
    .map((record) => {
      const stack = record.captureId === null ? 0 : (captureStack.get(record.captureId) ?? 0)
      if (record.captureId !== null) captureStack.set(record.captureId, stack + 1)
      const y = carpetTop + 15 + (stack % 4) * 7
      return `<circle
        class="trace-dot ${record.evidence} ${record.index === cursorIndex ? 'selected' : ''}"
        data-record-index="${record.index}"
        cx="${xForRecord(record.index)}"
        cy="${y}"
        r="2.8"
      ><title>#${record.index + 1} · ${escapeMarkup(record.payload._tag)} · ${escapeMarkup(record.evidence)}</title></circle>`
    })
    .join('')

  const lanesSvg = lanes
    .map(
      (lane) => `
        <text class="lane-label" x="8" y="${yAt(lane.key) + 4}">${escapeMarkup(lane.label)}</text>
        <line x1="${left}" x2="${width - right}" y1="${yAt(lane.key)}" y2="${yAt(lane.key)}" stroke="${lane.color}" stroke-width="2" />`,
    )
    .join('')

  timeline.className = 'timeline'
  timeline.innerHTML = `
    <svg
      viewBox="0 0 ${width} ${height}"
      role="slider"
      tabindex="0"
      aria-label="Trace cursor"
      aria-valuemin="0"
      aria-valuemax="${artifact.trace.length - 1}"
      aria-valuenow="${Math.max(cursorIndex, 0)}"
      aria-valuetext="${escapeMarkup(recordLabel.textContent ?? '')}"
    >
      ${lanesSvg}
      ${captureGuides}
      ${markerSvg}
      <text class="trace-carpet-label" x="8" y="${carpetTop + 18}">RAW TRACE</text>
      ${traceCarpet}
      ${
        cursorIndex < 0
          ? ''
          : `<g class="cursor-scrubber" aria-hidden="true">
              <line class="cursor-line" x1="${xForRecord(cursorIndex)}" x2="${xForRecord(cursorIndex)}" y1="10" y2="${height - 10}" />
              <circle class="cursor-handle" cx="${xForRecord(cursorIndex)}" cy="9" r="6" />
            </g>`
      }
    </svg>`
}

const bindEventSelection = (): void => {
  document.querySelectorAll<HTMLElement>('[data-event-ref]').forEach((element) => {
    element.addEventListener('click', () => {
      selectedEventRef = element.dataset.eventRef
      eventSelection.textContent = selectedEventRef === undefined ? '' : `Highlighting ${selectedEventRef}`
      render()
    })
  })
}

const bindTraceSelection = (): void => {
  timeline.querySelectorAll<SVGElement>('[data-record-index]').forEach((element) => {
    element.addEventListener('click', () => {
      const nextCursor = Number(element.dataset.recordIndex)
      if (Number.isInteger(nextCursor) === false) return
      stopPlayback()
      cursorIndex = nextCursor
      render()
    })
  })
}

const bindTimelineScrubber = (): void => {
  if (artifact === undefined) return
  const svg = timeline.querySelector('svg')
  if (svg === null) return

  const traceMax = Math.max(artifact.trace.length - 1, 0)
  const viewBoxWidth = 1400

  const moveCursor = (clientX: number, bounds: DOMRect): void => {
    const svgX = ((clientX - bounds.left) / bounds.width) * viewBoxWidth
    const nextCursor = timelineRecordPositions.reduce(
      (closest, position, index) =>
        Math.abs(position - svgX) < Math.abs((timelineRecordPositions[closest] ?? position) - svgX) ? index : closest,
      0,
    )
    if (nextCursor === cursorIndex) return
    stopPlayback()
    cursorIndex = nextCursor
    render()
  }

  svg.addEventListener('pointerdown', (event) => {
    if (
      event.target instanceof Element &&
      (event.target.closest('[data-event-ref]') !== null || event.target.closest('[data-record-index]') !== null)
    )
      return
    event.preventDefault()
    const bounds = svg.getBoundingClientRect()
    const pointerId = event.pointerId
    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId || moveEvent.buttons !== 1) return
      moveCursor(moveEvent.clientX, bounds)
    }
    const onPointerUp = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    moveCursor(event.clientX, bounds)
  })

  svg.addEventListener('keydown', (event) => {
    const nextCursor =
      event.key === 'ArrowLeft'
        ? cursorIndex - 1
        : event.key === 'ArrowRight'
          ? cursorIndex + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? traceMax
              : undefined
    if (nextCursor === undefined) return
    event.preventDefault()
    stopPlayback()
    cursorIndex = Math.min(Math.max(nextCursor, 0), traceMax)
    render()
    timeline.querySelector('svg')?.focus()
  })
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

const escapeMarkup = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
