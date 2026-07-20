import { Schema } from '@livestore/utils/effect'

import { type ComponentSyncObservation, type ObservedEvent, ScenarioRunArtifact } from '../model.ts'
import {
  backendComponentKey,
  deriveEventTimeline,
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
const runStatus = requireElement('run-status', HTMLElement)
const systemState = requireElement('system-state', HTMLElement)
const timeline = requireElement('timeline', HTMLElement)
const eventSelection = requireElement('event-selection', HTMLElement)
const recordDetails = requireElement('record-details', HTMLElement)

let artifact: ScenarioRunArtifact | undefined
let cursorIndex = -1
let selectedEventRef: string | undefined
let playTimer: number | undefined

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
  const height = lanes.length * laneHeight + 42
  const traceMax = Math.max(artifact.trace.length - 1, 1)
  const xAt = (index: number): number => left + (index / traceMax) * (width - left - right)
  const yAt = (key: string): number => (laneIndex.get(key) ?? 0) * laneHeight + 30
  const grouped = Map.groupBy(markers, (marker) => marker.event.eventRef)

  const paths = [...grouped.entries()]
    .filter(([, eventMarkers]) => eventMarkers.length > 1)
    .map(([eventRef, eventMarkers]) => {
      const points = eventMarkers.map((marker) => `${xAt(marker.recordIndex)},${yAt(marker.componentKey)}`).join(' ')
      return `<polyline class="path ${eventRef === selectedEventRef ? 'selected' : ''}" points="${points}" />`
    })
    .join('')

  const markerSvg = markers
    .map((marker) => {
      const selected = marker.event.eventRef === selectedEventRef ? 'selected' : ''
      const future = marker.recordIndex > cursorIndex ? 'opacity="0.22"' : ''
      return `
        <g
          class="marker ${marker.event.disposition} ${selected}"
          data-event-ref="${escapeMarkup(marker.event.eventRef)}"
          transform="translate(${xAt(marker.recordIndex) - 28} ${yAt(marker.componentKey) - 13})"
          ${future}
        >
          <title>${escapeMarkup(`${marker.event.name} · ${marker.event.eventRef}`)}</title>
          <rect width="56" height="26" rx="4" />
          <text x="28" y="17" text-anchor="middle">${escapeMarkup(marker.event.position)}</text>
        </g>`
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
      ${paths}
      ${markerSvg}
      ${
        cursorIndex < 0
          ? ''
          : `<g class="cursor-scrubber" aria-hidden="true">
              <line class="cursor-line" x1="${xAt(cursorIndex)}" x2="${xAt(cursorIndex)}" y1="10" y2="${height - 10}" />
              <circle class="cursor-handle" cx="${xAt(cursorIndex)}" cy="9" r="6" />
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

const bindTimelineScrubber = (): void => {
  if (artifact === undefined) return
  const svg = timeline.querySelector('svg')
  if (svg === null) return

  const traceMax = Math.max(artifact.trace.length - 1, 0)
  const viewBoxWidth = 1400
  const plotLeft = 180
  const plotRight = 35
  const plotWidth = viewBoxWidth - plotLeft - plotRight

  const moveCursor = (clientX: number, bounds: DOMRect): void => {
    const svgX = ((clientX - bounds.left) / bounds.width) * viewBoxWidth
    const ratio = Math.min(Math.max((svgX - plotLeft) / plotWidth, 0), 1)
    const nextCursor = Math.round(ratio * traceMax)
    if (nextCursor === cursorIndex) return
    stopPlayback()
    cursorIndex = nextCursor
    render()
  }

  svg.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-event-ref]') !== null) return
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
