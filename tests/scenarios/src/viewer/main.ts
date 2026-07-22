import { Schema } from '@livestore/utils/effect'

import {
  type ComponentSyncObservation,
  type ObservedEvent,
  ScenarioRunArtifact,
  type ScenarioTraceRecord,
} from '../model.ts'
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
  projectTraceAt,
  projectAdaptiveTime,
  sessionComponentKey,
  summarizeTraceRecord,
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
let selectedDetailRecordIndex: number | undefined
let selectedEventRef: string | undefined
let playTimer: number | undefined
let timelineMode: 'flow' | 'time' = 'flow'
let timeScaleMode: 'fit' | 'raw' = 'fit'
let traceVisibility: 'system' | 'all' = 'system'
let playbackMode: 'moments' | 'records' = 'moments'
let playbackMoments: ReturnType<typeof derivePlaybackMoments> = []
let timelineRecordPositions: ReadonlyArray<{ readonly index: number; readonly x: number }> = []
let timelineViewport = { start: 0, end: 1 }
const traceInspectorExpansion = {
  traceMetadataOpen: false,
  rawJsonOpen: false,
  jsonBranchesByRecord: new Map<string, Set<string>>(),
}
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
    readonly status?: 'passed' | 'failed'
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
          `${entry.label} · ${entry.applicationEventCount} events · ${entry.traceRecordCount} traces${entry.status === 'failed' ? ' · FAILED' : ''}`,
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
  selectedDetailRecordIndex = undefined
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
  const selectedMoment =
    playbackMode === 'moments' ? playbackMoments.find((moment) => moment.recordIndex === cursorIndex) : undefined
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
  const detailRecordIndexes = selectedMoment?.recordIndexes ?? (record === undefined ? [] : [record.index])
  if (selectedDetailRecordIndex === undefined || detailRecordIndexes.includes(selectedDetailRecordIndex) === false) {
    selectedDetailRecordIndex = detailRecordIndexes.at(-1)
  }
  recordDetails.className = record === undefined ? 'trace-inspector-empty' : 'trace-inspector'
  recordDetails.innerHTML =
    record === undefined
      ? 'No trace record selected.'
      : renderTraceInspector({
          trace,
          selectedMoment,
          recordIndexes: detailRecordIndexes,
          selectedRecordIndex: selectedDetailRecordIndex ?? record.index,
        })
  runStatus.textContent = projected.runStatus
  runStatus.className = `badge ${statusTone(projected.runStatus)}`
  systemState.className = 'topology'
  systemState.innerHTML = renderTopology(projected)
  restoreEventlogScrollState()
  renderTimeline()
  bindEventSelection()
  bindTraceInspector()
  bindTimelineScrubber()
  bindRangeNavigator()
}

type SelectedPlaybackMoment = ReturnType<typeof derivePlaybackMoments>[number]
type RecordFact = { readonly label: string; readonly value: string; readonly tone?: 'good' | 'warn' | 'bad' }

const renderTraceInspector = (args: {
  readonly trace: ReadonlyArray<ScenarioTraceRecord>
  readonly selectedMoment: SelectedPlaybackMoment | undefined
  readonly recordIndexes: ReadonlyArray<number>
  readonly selectedRecordIndex: number
}): string => {
  const records = args.recordIndexes.flatMap((index) => {
    const record = args.trace[index]
    return record === undefined ? [] : [record]
  })
  const selectedRecord = args.trace[args.selectedRecordIndex] ?? records.at(-1)
  if (selectedRecord === undefined) return 'No trace record selected.'

  const momentOrdinal = args.selectedMoment === undefined ? undefined : args.selectedMoment.momentIndex + 1
  const momentTitle =
    args.selectedMoment?.summary ?? `${summarizeTraceRecord(selectedRecord)} · record ${selectedRecord.index + 1}`
  const groupedRecords = groupDetailRecords(records)

  return `
    <header class="trace-inspector-heading">
      <div>
        <p class="trace-inspector-kicker">${
          momentOrdinal === undefined
            ? `RECORD ${selectedRecord.index + 1}`
            : `MOMENT ${momentOrdinal} · ${escapeMarkup(args.selectedMoment!.kind.toUpperCase())}`
        }</p>
        <h3>${escapeMarkup(momentTitle)}</h3>
      </div>
      <span>${records.length} ${records.length === 1 ? 'record' : 'records'}</span>
    </header>
    <div class="trace-inspector-layout">
      <nav class="moment-record-browser" aria-label="Records represented by this moment">
        ${groupedRecords
          .map(
            (group) => `
              <section class="moment-record-group">
                <h4>${escapeMarkup(group.label)}</h4>
                ${group.records
                  .map((record) => renderDetailRecordButton(record, record.index === selectedRecord.index))
                  .join('')}
              </section>`,
          )
          .join('')}
      </nav>
      ${renderSemanticRecord(selectedRecord)}
    </div>`
}

const groupDetailRecords = (
  records: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<{ readonly label: string; readonly records: ReadonlyArray<ScenarioTraceRecord> }> => {
  const groups = new Map<string, { label: string; records: ScenarioTraceRecord[] }>()
  for (const record of records) {
    const [key, label] =
      record.payload._tag === 'backend.observed'
        ? ['backend', 'Sync backend']
        : record.clientId !== null
          ? [`client:${record.clientId}`, record.clientId]
          : ['system', 'Scenario system']
    const group = groups.get(key) ?? { label, records: [] }
    group.records.push(record)
    groups.set(key, group)
  }
  return [...groups.values()]
}

const renderDetailRecordButton = (record: ScenarioTraceRecord, selected: boolean): string => {
  const scope = detailRecordScope(record)
  return `
    <button
      type="button"
      class="moment-record ${selected === true ? 'selected' : ''} origin-${record.origin}"
      data-detail-record-index="${record.index}"
      aria-pressed="${selected}"
    >
      <span class="moment-record-index">#${record.index + 1}</span>
      <span class="moment-record-copy">
        <strong>${escapeMarkup(scope)}</strong>
        <span>${escapeMarkup(record.payload._tag)}</span>
        <small>${escapeMarkup(summarizeTraceRecord(record))}</small>
      </span>
    </button>`
}

const detailRecordScope = (record: ScenarioTraceRecord): string => {
  if (record.payload._tag === 'backend.observed') return 'Backend'
  if (record.sessionId !== null) return record.sessionId
  if (record.clientId !== null && record.payload._tag === 'leader.sync.observed') return 'Leader'
  if (record.clientId !== null) return 'Client'
  return 'System'
}

const renderSemanticRecord = (record: ScenarioTraceRecord): string => {
  const facts = traceRecordFacts(record)
  const participant = [record.clientId, record.sessionId].filter((value) => value !== null).join(' / ')
  const openJsonPaths = traceRecordOpenJsonPaths(record)
  return `
    <article class="semantic-record">
      <header class="semantic-record-heading">
        <div>
          <p class="trace-inspector-kicker">#${record.index + 1} · ${escapeMarkup(record.origin.toUpperCase())}</p>
          <h3>${escapeMarkup(record.payload._tag)}</h3>
          <p>${escapeMarkup(summarizeTraceRecord(record))}</p>
        </div>
        <span class="evidence-chip">${escapeMarkup(record.evidence)}</span>
      </header>
      <div class="record-context">
        ${participant.length === 0 ? '' : `<span>scope <strong>${escapeMarkup(participant)}</strong></span>`}
        ${record.phaseId === null ? '' : `<span>phase <strong>${escapeMarkup(record.phaseId)}</strong></span>`}
        ${record.captureId === null ? '' : `<span>capture <strong>${escapeMarkup(record.captureId)}</strong></span>`}
      </div>
      ${
        facts.length === 0
          ? ''
          : `<dl class="record-facts">${facts
              .map(
                (fact) =>
                  `<div class="${fact.tone ?? ''}"><dt>${escapeMarkup(fact.label)}</dt><dd>${escapeMarkup(fact.value)}</dd></div>`,
              )
              .join('')}</dl>`
      }
      <details class="trace-metadata" data-inspector-section="trace-metadata" ${traceInspectorExpansion.traceMetadataOpen === true ? 'open' : ''}>
        <summary>Trace metadata</summary>
        <dl class="record-facts compact">
          <div><dt>Emitter</dt><dd>${escapeMarkup(record.emitterId)}</dd></div>
          <div><dt>Local sequence</dt><dd>${record.localSequence}</dd></div>
          <div><dt>Logical time</dt><dd>${record.logicalTime}</dd></div>
          <div><dt>Correlation</dt><dd>${escapeMarkup(record.correlationId ?? 'none')}</dd></div>
          <div><dt>Causation</dt><dd>${escapeMarkup(record.causationId ?? 'none')}</dd></div>
          <div><dt>Explicit causes</dt><dd>${record.causedBy.length === 0 ? 'none' : record.causedBy.map((index) => `#${index + 1}`).join(', ')}</dd></div>
        </dl>
      </details>
      <details class="raw-json-tree" data-inspector-section="raw-json" ${traceInspectorExpansion.rawJsonOpen === true ? 'open' : ''}>
        <summary>Raw JSON</summary>
        ${renderJsonTree(record, 'record', 'record', openJsonPaths)}
      </details>
    </article>`
}

const traceRecordFacts = (record: ScenarioTraceRecord): ReadonlyArray<RecordFact> => {
  const payload = record.payload
  switch (payload._tag) {
    case 'run.started':
      return [
        { label: 'Scenario', value: payload.scenarioId },
        { label: 'Application', value: payload.applicationId },
        { label: 'Seed', value: String(payload.seed) },
      ]
    case 'run.completed':
      return [{ label: 'Status', value: payload.status, tone: payload.status === 'passed' ? 'good' : 'bad' }]
    case 'run.failed':
      return [
        { label: 'Code', value: payload.code, tone: 'bad' },
        { label: 'Step', value: payload.stepId ?? 'unknown' },
        { label: 'Message', value: conciseText(payload.message), tone: 'bad' },
      ]
    case 'phase.started':
      return [{ label: 'Description', value: payload.description }]
    case 'client.create.requested':
      return [
        { label: 'Sessions', value: payload.sessions.join(', ') || 'none' },
        { label: 'Initially connected', value: String(payload.initiallyConnected) },
      ]
    case 'client.created':
      return [{ label: 'Status', value: payload.status, tone: 'good' }]
    case 'action.completed':
      return [
        { label: 'Action', value: payload.action },
        { label: 'Status', value: payload.status, tone: 'good' },
      ]
    case 'action.requested':
      return [
        { label: 'Action', value: payload.action },
        { label: 'Input', value: jsonValueSummary(payload.input) },
      ]
    case 'connectivity.disconnect.requested':
    case 'connectivity.reconnect.requested':
    case 'connectivity.disconnected':
    case 'connectivity.reconnected':
      return [
        { label: 'Connected', value: String(payload.connected), tone: payload.connected === true ? 'good' : 'warn' },
      ]
    case 'settlement.requested':
      return [
        { label: 'Participants', value: payload.participants.join(', ') },
        { label: 'Heal', value: payload.healDisconnectedClients.join(', ') || 'none' },
        { label: 'Timeout', value: `${payload.timeoutMs} ms` },
      ]
    case 'settlement.progress':
      return [
        { label: 'Settled', value: String(payload.settled), tone: payload.settled === true ? 'good' : 'warn' },
        { label: 'Observations', value: `${payload.observations.length} participants` },
      ]
    case 'settlement.completed':
      return [{ label: 'Observations', value: `${payload.observations.length} settled participants`, tone: 'good' }]
    case 'settlement.failed':
      return [
        { label: 'Code', value: payload.code, tone: 'bad' },
        { label: 'Timeout', value: `${payload.timeoutMs} ms` },
        { label: 'Observations', value: `${payload.observations.length} participants` },
        { label: 'Message', value: conciseText(payload.message), tone: 'bad' },
      ]
    case 'runtime.failure.observed':
      return [
        { label: 'Source', value: payload.source },
        { label: 'Code', value: payload.code, tone: 'bad' },
        { label: 'Message', value: conciseText(payload.message), tone: 'bad' },
      ]
    case 'sync.snapshot':
      return syncObservationFacts(payload)
    case 'state.snapshot':
      return [
        { label: 'Inspector', value: payload.inspector },
        { label: 'Value', value: jsonValueSummary(payload.value) },
      ]
    case 'backend.observed':
      return [
        { label: 'Reason', value: payload.reason },
        { label: 'Connected', value: String(payload.observation.connected) },
        { label: 'Head', value: payload.observation.head },
        { label: 'Events', value: `${payload.observation.events.length} observed` },
      ]
    case 'client.connectivity.observed':
      return [
        { label: 'Reason', value: payload.reason },
        { label: 'Connected', value: String(payload.connected), tone: payload.connected === true ? 'good' : 'warn' },
      ]
    case 'leader.sync.observed':
    case 'session.sync.observed':
      return [{ label: 'Reason', value: payload.reason }, ...componentObservationFacts(payload.observation)]
    case 'oracle.verdict':
      return [
        { label: 'Oracle', value: payload.oracle },
        { label: 'Status', value: payload.status, tone: payload.status === 'passed' ? 'good' : 'bad' },
        { label: 'Summary', value: payload.summary },
        { label: 'Evidence', value: `${payload.evidence.length} records` },
      ]
    default:
      return []
  }
}

const syncObservationFacts = (observation: {
  readonly participant: string
  readonly localHead: string
  readonly upstreamHead: string
  readonly pendingCount: number
  readonly isSynced: boolean
}): ReadonlyArray<RecordFact> => [
  { label: 'Participant', value: observation.participant },
  { label: 'Local head', value: observation.localHead },
  { label: 'Upstream head', value: observation.upstreamHead },
  { label: 'Pending', value: String(observation.pendingCount), tone: observation.pendingCount === 0 ? 'good' : 'warn' },
  { label: 'Synced', value: String(observation.isSynced), tone: observation.isSynced === true ? 'good' : 'warn' },
]

const componentObservationFacts = (observation: ComponentSyncObservation): ReadonlyArray<RecordFact> => [
  { label: 'Local head', value: observation.localHead },
  { label: 'Upstream head', value: observation.upstreamHead },
  { label: 'Pending', value: String(observation.pendingCount), tone: observation.pendingCount === 0 ? 'good' : 'warn' },
  { label: 'Events', value: `${observation.events.length} observed` },
]

const conciseText = (value: string): string => {
  const firstLine = value.split('\n', 1)[0]?.trim() ?? value.trim()
  return firstLine.length <= 220 ? firstLine : `${firstLine.slice(0, 219)}…`
}

const jsonValueSummary = (value: unknown): string => {
  if (Array.isArray(value) === true) return `Array(${value.length})`
  if (value !== null && typeof value === 'object') return `Object(${Object.keys(value).length})`
  if (typeof value === 'string') return conciseText(value)
  return String(value)
}

const renderJsonTree = (value: unknown, label: string, path: string, openPaths: ReadonlySet<string>): string => {
  if (value === null || typeof value !== 'object') {
    const type = value === null ? 'null' : typeof value
    const renderedValue = typeof value === 'string' ? `“${value}”` : String(value)
    return `<div class="json-leaf"><span class="json-key">${escapeMarkup(label)}</span><span class="json-value ${type}">${escapeMarkup(renderedValue)}</span></div>`
  }

  const isArray = Array.isArray(value)
  const entries = isArray === true ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)
  const shape = isArray === true ? `Array(${entries.length})` : `Object(${entries.length})`
  if (entries.length === 0) {
    return `<div class="json-leaf"><span class="json-key">${escapeMarkup(label)}</span><span class="json-shape">${shape}</span></div>`
  }
  return `
    <details class="json-branch" data-json-path="${escapeMarkup(path)}" ${openPaths.has(path) === true ? 'open' : ''}>
      <summary><span class="json-key">${escapeMarkup(label)}</span><span class="json-shape">${shape}</span></summary>
      <div class="json-children">
        ${entries
          .map(([key, child]) => renderJsonTree(child, key, `${path}/${escapeJsonPointerSegment(key)}`, openPaths))
          .join('')}
      </div>
    </details>`
}

const bindTraceInspector = (): void => {
  recordDetails.querySelectorAll<HTMLDetailsElement>('[data-inspector-section]').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (details.dataset.inspectorSection === 'trace-metadata') {
        traceInspectorExpansion.traceMetadataOpen = details.open
      } else if (details.dataset.inspectorSection === 'raw-json') {
        traceInspectorExpansion.rawJsonOpen = details.open
      }
    })
  })

  const selectedRecord =
    artifact === undefined || selectedDetailRecordIndex === undefined
      ? undefined
      : artifact.trace[selectedDetailRecordIndex]
  if (selectedRecord !== undefined) {
    const openJsonPaths = traceRecordOpenJsonPaths(selectedRecord)
    recordDetails.querySelectorAll<HTMLDetailsElement>('[data-json-path]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const path = details.dataset.jsonPath
        if (path === undefined) return
        if (details.open === true) openJsonPaths.add(path)
        else openJsonPaths.delete(path)
      })
    })
  }

  recordDetails.querySelectorAll<HTMLButtonElement>('[data-detail-record-index]').forEach((button) => {
    button.addEventListener('click', () => {
      const recordIndex = Number(button.dataset.detailRecordIndex)
      if (Number.isInteger(recordIndex) === false || recordIndex === selectedDetailRecordIndex) return
      selectedDetailRecordIndex = recordIndex
      render()
    })
  })
}

/** Keeps raw-tree expansion local to one record without persisting viewer state across refreshes. */
const traceRecordOpenJsonPaths = (record: ScenarioTraceRecord): Set<string> => {
  const key = `${record.runId}:${record.index}`
  const existing = traceInspectorExpansion.jsonBranchesByRecord.get(key)
  if (existing !== undefined) return existing
  const initial = new Set(['record'])
  traceInspectorExpansion.jsonBranchesByRecord.set(key, initial)
  return initial
}

const escapeJsonPointerSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1')

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
      const badge =
        client.health === 'failed' || client.health === 'degraded'
          ? [client.health, 'bad']
          : client.connected === false
            ? ['offline', 'bad']
            : syncBadge(client.leader)
      return `
        <article class="component-card" style="--component-color:${color}">
          <div class="component-title">
            <h3>${escapeMarkup(client.clientId)}</h3>
            <span class="badge ${badge[1]}">${badge[0]}</span>
          </div>
          ${renderEventlog(`client:${client.clientId}`, client.leader?.events ?? [], client.leader === null ? 'Leader not observed' : `Client eventlog · ${client.leader.pendingCount} pending`)}
          <div class="role-list">
            ${renderRole('Leader role', client.leader, client.health === 'failed' ? 'failed' : undefined)}
            ${client.sessions.map((session) => renderRole(`Session ${session.sessionId}`, session.sync, session.health)).join('')}
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

const renderRole = (
  label: string,
  sync: ComponentSyncObservation | null,
  health?: 'unknown' | 'healthy' | 'failed',
): string => `
  <div class="role-row ${health === 'failed' ? 'runtime-failed' : ''}">
    <strong>${escapeMarkup(label)}</strong>
    <span>${
      sync === null
        ? 'not observed'
        : `local ${escapeMarkup(sync.localHead)} · upstream ${escapeMarkup(sync.upstreamHead)} · ${sync.pendingCount} pending`
    }${health === 'failed' ? ' · <em class="runtime-health">runtime failed</em>' : ''}</span>
  </div>`

const renderTimeline = (): void => {
  if (artifact === undefined) return
  const trace = artifact.trace
  const markers = deriveEventTimeline(trace)
  const captures = deriveTraceCaptures(trace)
  const connectivityIntervals = deriveConnectivityIntervals(trace)
  const laneActivityIntervals = deriveLaneActivityIntervals({ scenario: artifact.scenario, trace })
  const runtimeFailureIntervals = deriveRuntimeFailureIntervals(trace)
  const clientsById = new Map(artifact.scenario.topology.clients.map((client) => [client.id, client]))
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

  const offlineBands = connectivityIntervals
    .map((interval) => {
      const client = clientsById.get(interval.clientId)
      if (client === undefined) return ''
      const intervalStart = normalizedForRecord(interval.startRecordIndex)
      const endRecordIndex = interval.endRecordIndex ?? trace.at(-1)?.index ?? interval.startRecordIndex
      const intervalEnd = normalizedForRecord(endRecordIndex)
      if (intervalEnd < timelineViewport.start || intervalStart > timelineViewport.end) return ''
      const visibleStart = Math.max(intervalStart, timelineViewport.start)
      const visibleEnd = Math.min(intervalEnd, timelineViewport.end)
      const x1 = xForNormalized(visibleStart)
      const x2 = Math.max(xForNormalized(visibleEnd), x1 + 2)
      const leaderY = yAt(leaderComponentKey(client.id))
      const lastSessionId = client.sessions.at(-1)
      const lastSessionY = lastSessionId === undefined ? leaderY : yAt(sessionComponentKey(client.id, lastSessionId))
      const y = leaderY - 23
      const bandHeight = lastSessionY - leaderY + 46
      const uncertain =
        interval.startEvidence === 'first-observed' || interval.endEvidence === 'first-observed' ? 'uncertain' : ''
      const boundaryDescription = `${interval.startEvidence} → ${interval.endEvidence ?? 'still disconnected'}`
      const label = x2 - x1 >= 92 ? `<text class="offline-period-label" x="${x1 + 6}" y="${y + 12}">OFFLINE</text>` : ''
      return `
        <g class="offline-period ${uncertain}">
          <title>${escapeMarkup(interval.clientId)} offline · ${escapeMarkup(boundaryDescription)}</title>
          <rect x="${x1}" y="${y}" width="${x2 - x1}" height="${bandHeight}" rx="2" />
          ${label}
        </g>`
    })
    .join('')

  const settlementFailures = trace.filter((record) => record.payload._tag === 'settlement.failed')
  const failureRecords =
    settlementFailures.length > 0 ? settlementFailures : trace.filter((record) => record.payload._tag === 'run.failed')
  const failureMarkers = failureRecords
    .filter((record) => isVisibleRecord(record.index))
    .map((record) => {
      const x = xForRecord(record.index)
      const message = 'message' in record.payload ? record.payload.message : 'Scenario execution failed'
      return `<g class="failure-boundary" data-record-index="${record.index}">
        <title>${escapeMarkup(message)}</title>
        <line x1="${x}" x2="${x}" y1="3" y2="${carpetTop - 8}" />
        <path d="M ${x} 3 l 7 7 l -7 7 l -7 -7 z" />
        <text x="${x - 7}" y="13" text-anchor="end">RUN FAILED</text>
      </g>`
    })
    .join('')

  const momentByRecordIndex = new Map(playbackMoments.map((moment) => [moment.recordIndex, moment]))
  const participantMilestones = trace
    .filter((record) => isVisibleRecord(record.index))
    .map((record) => {
      const x = xForRecord(record.index)
      const title = escapeMarkup(momentByRecordIndex.get(record.index)?.summary ?? record.payload._tag)
      const client = record.clientId === null ? undefined : clientsById.get(record.clientId)
      const leaderY = client === undefined ? undefined : yAt(leaderComponentKey(client.id))
      const lastSessionId = client?.sessions.at(-1)
      const groupEndY =
        client === undefined || leaderY === undefined
          ? undefined
          : lastSessionId === undefined
            ? leaderY
            : yAt(sessionComponentKey(client.id, lastSessionId))

      switch (record.payload._tag) {
        case 'client.created':
          return leaderY === undefined || groupEndY === undefined
            ? ''
            : `<g class="participant-milestone topology" data-record-index="${record.index}">
                <title>${title}</title>
                <line class="group-boundary" x1="${x}" x2="${x}" y1="${leaderY - 10}" y2="${groupEndY + 10}" />
                <path d="M ${x} ${leaderY - 6} l 6 6 l -6 6 l -6 -6 z" />
              </g>`
        case 'action.requested': {
          if (record.clientId === null) return ''
          const componentKey =
            record.sessionId === null
              ? leaderComponentKey(record.clientId)
              : sessionComponentKey(record.clientId, record.sessionId)
          const y = yAt(componentKey)
          return `<g class="participant-milestone action" data-record-index="${record.index}">
              <title>${title}</title>
              <line x1="${x}" x2="${x}" y1="${y - 8}" y2="${y + 8}" />
              <path d="M ${x} ${y - 10} l 5 6 h -10 z" />
            </g>`
        }
        case 'connectivity.disconnected':
        case 'connectivity.reconnected':
          return leaderY === undefined || groupEndY === undefined
            ? ''
            : `<g class="participant-milestone connectivity ${record.payload._tag === 'connectivity.disconnected' ? 'disconnected' : 'reconnected'}" data-record-index="${record.index}">
                <title>${title}</title>
                <line x1="${x}" x2="${x}" y1="${leaderY - 7}" y2="${groupEndY + 7}" />
                <circle cx="${x}" cy="${leaderY}" r="3.5" />
              </g>`
        case 'lifecycle.session-stopped':
        case 'lifecycle.session-restarted': {
          if (record.clientId === null || record.sessionId === null) return ''
          const y = yAt(sessionComponentKey(record.clientId, record.sessionId))
          const restarted = record.payload._tag === 'lifecycle.session-restarted'
          return `<g class="participant-milestone lifecycle ${restarted === true ? 'restarted' : 'stopped'}" data-record-index="${record.index}">
              <title>${title}</title>
              <line x1="${x}" x2="${x}" y1="${y - 8}" y2="${y + 8}" />
              <circle cx="${x}" cy="${y}" r="4" />
            </g>`
        }
        case 'lifecycle.client-restarted':
          return leaderY === undefined || groupEndY === undefined
            ? ''
            : `<g class="participant-milestone lifecycle restarted" data-record-index="${record.index}">
                <title>${title}</title>
                <line x1="${x}" x2="${x}" y1="${leaderY - 8}" y2="${groupEndY + 8}" />
                <circle cx="${x}" cy="${leaderY}" r="4" />
              </g>`
        default:
          return ''
      }
    })
    .join('')

  const runtimeFailureSvg = runtimeFailureIntervals
    .map((interval) => {
      const start = normalizedForRecord(interval.startRecordIndex)
      const endRecordIndex = interval.endRecordIndex ?? trace.at(-1)?.index ?? interval.startRecordIndex
      const end = normalizedForRecord(endRecordIndex)
      if (end < timelineViewport.start || start > timelineViewport.end) return ''
      const visibleStart = Math.max(start, timelineViewport.start)
      const visibleEnd = Math.min(Math.max(start, end), timelineViewport.end)
      const x1 = xForNormalized(visibleStart)
      const x2 = Math.max(xForNormalized(visibleEnd), x1 + 2)
      const y = yAt(interval.componentKey)
      const failureTrackY = y + 23
      const originVisible = start >= timelineViewport.start && start <= timelineViewport.end
      const terminalStartX = originVisible === true ? Math.min(x1 + 7, x2) : x1
      const duplicateCount = interval.recordIndexes.length
      const title = `${interval.clientId}${interval.sessionId === null ? '' : `/${interval.sessionId}`}: runtime failure: ${interval.summary}${duplicateCount > 1 ? ` · ${duplicateCount} related records` : ''}`
      return `<g class="runtime-failure-interval">
          <title>${escapeMarkup(title)}</title>
          <line class="runtime-failure-terminal" x1="${terminalStartX}" x2="${x2}" y1="${failureTrackY}" y2="${failureTrackY}" />
          ${
            originVisible === false
              ? ''
              : `<g class="runtime-failure-callout" data-record-index="${interval.startRecordIndex}">
                  <line x1="${x1}" x2="${x1}" y1="${y + 12}" y2="${failureTrackY - 5}" />
                  <path d="M ${x1} ${failureTrackY - 5} l 5 5 l -5 5 l -5 -5 z" />
                  <text x="${x1 - 8}" y="${y + 40}" text-anchor="end">RUNTIME FAILURE</text>
                </g>`
          }
        </g>`
    })
    .join('')

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
            const radius = moment.kind === 'capture' ? 2.1 : moment.kind === 'failure' ? 3.8 : 3.2
            return `<circle
              class="trace-dot system-moment moment-${moment.kind} ${record.evidence} ${moment.recordIndexes.includes(cursorIndex) === true ? 'selected' : ''}"
              data-record-index="${moment.recordIndex}"
              cx="${xForCarpetRecord(moment.recordIndex)}"
              cy="${carpetTop + 15}"
              r="${radius}"
            ><title>moment ${moment.momentIndex + 1} · ${escapeMarkup(moment.label)} · ${escapeMarkup(moment.summary)} · record ${moment.recordIndex + 1}</title></circle>`
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
    .map((lane) => {
      const activeSegments = laneActivityIntervals
        .filter((interval) => interval.componentKey === lane.key)
        .map((interval) => {
          const intervalStart = normalizedForRecord(interval.startRecordIndex)
          const intervalEnd = interval.endRecordIndex === null ? 1 : normalizedForRecord(interval.endRecordIndex)
          const start = Math.min(intervalStart, intervalEnd)
          const end = Math.max(intervalStart, intervalEnd)
          if (end < timelineViewport.start || start > timelineViewport.end) return ''
          const x1 = xForNormalized(Math.max(start, timelineViewport.start))
          const x2 = xForNormalized(Math.min(end, timelineViewport.end))
          return `<line class="lane-track active" x1="${x1}" x2="${Math.max(x2, x1 + 1)}" y1="${yAt(lane.key)}" y2="${yAt(lane.key)}" stroke="${lane.color}" />`
        })
        .join('')
      return `
        <text class="lane-label ${lane.role}" x="${lane.role === 'session' ? 36 : 8}" y="${yAt(lane.key) + 4}">${escapeMarkup(lane.label)}</text>
        <line class="lane-track declared" x1="${left}" x2="${width - right}" y1="${yAt(lane.key)}" y2="${yAt(lane.key)}" stroke="${lane.color}" />
        ${activeSegments}`
    })
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
  const navigatorOfflinePeriods = connectivityIntervals
    .map((interval) => {
      const start = normalizedForRecord(interval.startRecordIndex)
      const endRecordIndex = interval.endRecordIndex ?? trace.at(-1)?.index ?? interval.startRecordIndex
      const end = normalizedForRecord(endRecordIndex)
      const x1 = overviewXForNormalized(start)
      const x2 = Math.max(overviewXForNormalized(end), x1 + 1)
      return `<rect class="range-offline-period" x="${x1}" y="30" width="${x2 - x1}" height="4"><title>${escapeMarkup(interval.clientId)} offline</title></rect>`
    })
    .join('')
  const navigatorFailures = failureRecords
    .map((record) => {
      const x = overviewXForNormalized(normalizedForRecord(record.index))
      return `<line class="range-failure" x1="${x}" x2="${x}" y1="5" y2="37"><title>${escapeMarkup(record.payload._tag)}</title></line>`
    })
    .join('')
  const navigatorRuntimeFailures = runtimeFailureIntervals
    .map((interval) => {
      const x = overviewXForNormalized(normalizedForRecord(interval.startRecordIndex))
      const participant = `${interval.clientId}${interval.sessionId === null ? '' : `/${interval.sessionId}`}`
      return `<line class="range-runtime-failure" x1="${x}" x2="${x}" y1="18" y2="36"><title>${escapeMarkup(`${participant}: ${interval.summary}`)}</title></line>`
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
      ${offlineBands}
      ${failureMarkers}
      ${hierarchySvg}
      ${lanesSvg}
      ${participantMilestones}
      ${captureGuides}
      ${markerSvg}
      ${runtimeFailureSvg}
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
      ${navigatorOfflinePeriods}
      ${navigatorRuntimeFailures}
      ${navigatorFailures}
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
