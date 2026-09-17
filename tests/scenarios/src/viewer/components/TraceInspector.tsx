/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Disclosure callbacks and tooltip content bind the selected record at leaf nodes. */
import type { ScenarioTraceRecord } from '../../model.ts'
import type { PlaybackMoment } from '../../projection.ts'
import { summarizeTraceRecord } from '../../projection.ts'
import { detailRecordScope, groupDetailRecords, traceRecordFacts } from '../trace-inspector-model.ts'
import { Tooltip } from './Tooltip.tsx'

export interface InspectorExpansionState {
  readonly traceMetadataOpen: boolean
  readonly rawJsonOpen: boolean
  readonly jsonBranchesByRecord: ReadonlyMap<string, ReadonlySet<string>>
}

export const RecordListItem = ({
  record,
  selected,
  onSelect,
}: {
  readonly record: ScenarioTraceRecord
  readonly selected: boolean
  readonly onSelect: (recordIndex: number) => void
}) => (
  <button
    type="button"
    className={`moment-record ${selected === true ? 'selected' : ''} origin-${record.origin}`}
    aria-pressed={selected}
    onClick={() => onSelect(record.index)}
  >
    <span className="moment-record-index">#{record.index + 1}</span>
    <span className="moment-record-copy">
      <strong>{detailRecordScope(record)}</strong>
      <span>{record.payload._tag}</span>
      <small>{summarizeTraceRecord(record)}</small>
    </span>
  </button>
)

export const MomentRecordBrowser = ({
  records,
  selectedRecordIndex,
  onSelect,
}: {
  readonly records: ReadonlyArray<ScenarioTraceRecord>
  readonly selectedRecordIndex: number
  readonly onSelect: (recordIndex: number) => void
}) => (
  <nav className="moment-record-browser" aria-label="Records represented by this moment">
    {groupDetailRecords(records).map((group) => (
      <section key={group.label} className="moment-record-group">
        <h4>{group.label}</h4>
        {group.records.map((record) => (
          <RecordListItem
            key={record.index}
            record={record}
            selected={record.index === selectedRecordIndex}
            onSelect={onSelect}
          />
        ))}
      </section>
    ))}
  </nav>
)

export const JsonTree = ({
  value,
  label,
  path,
  openPaths,
  onToggle,
}: {
  readonly value: unknown
  readonly label: string
  readonly path: string
  readonly openPaths: ReadonlySet<string>
  readonly onToggle: (path: string, open: boolean) => void
}) => {
  if (value === null || typeof value !== 'object') {
    const type = value === null ? 'null' : typeof value
    return (
      <div className="json-leaf">
        <span className="json-key">{label}</span>
        <span className={`json-value ${type}`}>{typeof value === 'string' ? `“${value}”` : String(value)}</span>
      </div>
    )
  }
  const entries: ReadonlyArray<readonly [string, unknown]> =
    Array.isArray(value) === true ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)
  const shape = Array.isArray(value) === true ? `Array(${entries.length})` : `Object(${entries.length})`
  if (entries.length === 0) {
    return (
      <div className="json-leaf">
        <span className="json-key">{label}</span>
        <span className="json-shape">{shape}</span>
      </div>
    )
  }
  return (
    <details
      open={openPaths.has(path)}
      className="json-branch"
      onToggle={(event) => onToggle(path, event.currentTarget.open)}
    >
      <summary>
        <span className="json-key">{label}</span>
        <span className="json-shape">{shape}</span>
      </summary>
      <div className="json-children">
        {entries.map(([key, child]) => (
          <JsonTree
            key={key}
            value={child}
            label={key}
            path={`${path}/${escapeJsonPointerSegment(key)}`}
            openPaths={openPaths}
            onToggle={onToggle}
          />
        ))}
      </div>
    </details>
  )
}

export const SemanticRecord = ({
  record,
  expansion,
  openJsonPaths,
  onSectionToggle,
  onJsonToggle,
}: {
  readonly record: ScenarioTraceRecord
  readonly expansion: InspectorExpansionState
  readonly openJsonPaths: ReadonlySet<string>
  readonly onSectionToggle: (section: 'traceMetadataOpen' | 'rawJsonOpen', open: boolean) => void
  readonly onJsonToggle: (path: string, open: boolean) => void
}) => {
  const participant = [record.clientId, record.sessionId].filter((value) => value !== null).join(' / ')
  const facts = traceRecordFacts(record)
  return (
    <article className="semantic-record">
      <header className="semantic-record-heading">
        <div>
          <p className="trace-inspector-kicker">
            #{record.index + 1} · {record.origin.toUpperCase()}
          </p>
          <h3>{record.payload._tag}</h3>
          <p>{summarizeTraceRecord(record)}</p>
        </div>
        <span className="evidence-chip">{record.evidence}</span>
      </header>
      <div className="record-context">
        {participant.length > 0 ? (
          <span>
            scope <strong>{participant}</strong>
          </span>
        ) : null}
        {record.captureId !== null ? (
          <span>
            capture <strong>{record.captureId}</strong>
          </span>
        ) : null}
      </div>
      {facts.length > 0 ? (
        <dl className="record-facts">
          {facts.map((fact) => (
            <div key={fact.label} className={fact.tone ?? ''}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details
        className="trace-metadata"
        open={expansion.traceMetadataOpen}
        onToggle={(event) => onSectionToggle('traceMetadataOpen', event.currentTarget.open)}
      >
        <summary>Trace metadata</summary>
        <dl className="record-facts compact">
          <div>
            <dt>Emitter</dt>
            <dd>{record.emitterId}</dd>
          </div>
          <div>
            <dt>Local sequence</dt>
            <dd>{record.localSequence}</dd>
          </div>
          <div>
            <dt>Logical time</dt>
            <dd>{record.logicalTime}</dd>
          </div>
          <div>
            <dt>Correlation (association)</dt>
            <dd>{record.correlationId ?? 'none'}</dd>
          </div>
          <div>
            <dt>Legacy causation label</dt>
            <dd>{record.causationId ?? 'none'}</dd>
          </div>
          <div>
            <dt>Explicit dependencies</dt>
            <dd>
              {record.causedBy.length === 0 ? 'none' : record.causedBy.map((index) => `#${index + 1}`).join(', ')}
            </dd>
          </div>
        </dl>
      </details>
      <details
        className="raw-json-tree"
        open={expansion.rawJsonOpen}
        onToggle={(event) => onSectionToggle('rawJsonOpen', event.currentTarget.open)}
      >
        <summary>Raw JSON</summary>
        <JsonTree value={record} label="record" path="record" openPaths={openJsonPaths} onToggle={onJsonToggle} />
      </details>
    </article>
  )
}

export const TraceInspector = ({
  trace,
  selectedMoment,
  recordIndexes,
  selectedRecordIndex,
  expansion,
  onSelectRecord,
  onSectionToggle,
  onJsonToggle,
}: {
  readonly trace: ReadonlyArray<ScenarioTraceRecord>
  readonly selectedMoment?: PlaybackMoment
  readonly recordIndexes: ReadonlyArray<number>
  readonly selectedRecordIndex: number
  readonly expansion: InspectorExpansionState
  readonly onSelectRecord: (recordIndex: number) => void
  readonly onSectionToggle: (section: 'traceMetadataOpen' | 'rawJsonOpen', open: boolean) => void
  readonly onJsonToggle: (record: ScenarioTraceRecord, path: string, open: boolean) => void
}) => {
  const records = recordIndexes.flatMap((index) => (trace[index] === undefined ? [] : [trace[index]]))
  const selectedRecord = trace[selectedRecordIndex] ?? records.at(-1)
  if (selectedRecord === undefined) return <div className="trace-inspector-empty">No trace record selected.</div>
  const momentTitle =
    selectedMoment?.summary ?? `${summarizeTraceRecord(selectedRecord)} · record ${selectedRecord.index + 1}`
  const openJsonPaths =
    expansion.jsonBranchesByRecord.get(`${selectedRecord.runId}:${selectedRecord.index}`) ?? new Set(['record'])
  return (
    <div className="trace-inspector">
      <header className="trace-inspector-heading">
        <div>
          <p className="trace-inspector-kicker">
            {selectedMoment === undefined
              ? `RECORD ${selectedRecord.index + 1}`
              : `MOMENT ${selectedMoment.momentIndex + 1} · ${selectedMoment.kind.toUpperCase()}`}
          </p>
          <Tooltip content={{ title: momentTitle }}>
            <h3 tabIndex={0}>{momentTitle}</h3>
          </Tooltip>
        </div>
        <span>
          {records.length} {records.length === 1 ? 'record' : 'records'}
        </span>
      </header>
      <div className="trace-inspector-layout">
        <MomentRecordBrowser records={records} selectedRecordIndex={selectedRecord.index} onSelect={onSelectRecord} />
        <SemanticRecord
          record={selectedRecord}
          expansion={expansion}
          openJsonPaths={openJsonPaths}
          onSectionToggle={onSectionToggle}
          onJsonToggle={(path, open) => onJsonToggle(selectedRecord, path, open)}
        />
      </div>
    </div>
  )
}

const escapeJsonPointerSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1')
