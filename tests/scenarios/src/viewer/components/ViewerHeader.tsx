/* eslint-disable react-perf/jsx-no-new-function-as-prop -- Picker handlers are local leaf interactions. */
import { useState, type ChangeEvent, type ReactNode } from 'react'

import { formatDuration } from '../../performance.ts'
import { displaySourceRevision } from '../../source-revision.ts'
import type { ArtifactCatalog } from '../artifact-io.ts'
import { RunComparison } from './RunComparison.tsx'

type Entry = ArtifactCatalog['entries'][number]
const targetName = (entry: Entry): string => /^(BRANCH|BASELINE|CANDIDATE) · /.exec(entry.label)?.[1] ?? 'Core'
const columns = [
  ['scenarioId', 'Scenario'],
  ['sourceRevision', 'Target'],
  ['profile', 'Profile'],
  ['backend', 'Backend'],
  ['applicationEventCount', 'Events'],
  ['traceRecordCount', 'Traces'],
  ['status', 'Result'],
  ['runMs', 'Time to pass'],
] as const
type SortKey = (typeof columns)[number][0]

export const ArtifactPicker = ({
  catalog,
  catalogError,
  selectedFile,
  onSelectedFileChange,
  onFile,
  onLoad,
}: {
  readonly catalog: ArtifactCatalog | undefined
  readonly catalogError: string | undefined
  readonly selectedFile: string
  readonly onSelectedFileChange: (file: string) => void
  readonly onFile: (file: File) => void
  readonly onLoad: (file: string) => void
}) => {
  const [expanded, setExpanded] = useState(true)
  const [view, setView] = useState<'runs' | 'compare'>('runs')
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState('')
  const [profile, setProfile] = useState('')
  const [result, setResult] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'scenarioId', descending: false })
  const entries = catalog?.entries ?? []
  const targets = [...new Set(entries.map((entry) => entry.sourceRevision))]
  const visible = entries
    .filter(
      (entry) =>
        (target === '' || entry.sourceRevision === target) &&
        (profile === '' || entry.profile === profile) &&
        (result === '' || entry.status === result) &&
        `${entry.label} ${entry.sourceRevision} ${entry.file}`.toLowerCase().includes(query.toLowerCase()),
    )
    .toSorted((a, b) => {
      const av = sort.key === 'runMs' ? a.timings?.runMs : a[sort.key]
      const bv = sort.key === 'runMs' ? b.timings?.runMs : b[sort.key]
      if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? 1 : -1
      const comparison =
        typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return (
        (sort.descending ? -comparison : comparison) ||
        a.scenarioId.localeCompare(b.scenarioId) ||
        a.file.localeCompare(b.file)
      )
    })
  const handleFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    if (file !== undefined) onFile(file)
  }
  return (
    <div className="run-picker">
      <div className="run-picker-heading">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="saved-runs"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '▾' : '▸'} Saved runs <span className="run-muted">({entries.length})</span>
        </button>
        <button
          type="button"
          aria-pressed={view === 'runs'}
          onClick={() => {
            setView('runs')
            setExpanded(true)
          }}
        >
          Runs
        </button>
        <button
          type="button"
          aria-pressed={view === 'compare'}
          onClick={() => {
            setView('compare')
            setExpanded(true)
          }}
        >
          Compare
        </button>
        <label className="file-button">
          open file
          <input type="file" accept="application/json,application/gzip,.json,.json.gz" onChange={handleFile} />
        </label>
      </div>
      {expanded && view === 'compare' && (
        <div id="saved-runs">
          <RunComparison
            catalog={catalog}
            onLoad={(file) => {
              onSelectedFileChange(file)
              onLoad(file)
            }}
          />
        </div>
      )}
      {expanded && view === 'runs' && (
        <section id="saved-runs" aria-label="Saved runs" className="run-browser">
          <div className="run-filters">
            <input
              type="search"
              aria-label="Search runs"
              placeholder="Search scenarios or revisions…"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <select
              aria-label="Filter target"
              value={target}
              onChange={(event) => setTarget(event.currentTarget.value)}
            >
              <option value="">All targets</option>
              {targets.map((revision) => (
                <option key={revision} value={revision}>
                  {targetName(entries.find((entry) => entry.sourceRevision === revision)!)} ·{' '}
                  {displaySourceRevision(revision).compact}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter profile"
              value={profile}
              onChange={(event) => setProfile(event.currentTarget.value)}
            >
              <option value="">All profiles</option>
              <option value="browser">Browser</option>
              <option value="in-process">In-process</option>
              <option value="process">Process</option>
            </select>
            <select
              aria-label="Filter result"
              value={result}
              onChange={(event) => setResult(event.currentTarget.value)}
            >
              <option value="">All results</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
            </select>
            <span className="run-muted" role="status">
              {visible.length} of {entries.length} runs
            </span>
          </div>
          {catalogError ? (
            <p role="alert">{catalogError}</p>
          ) : catalog === undefined ? (
            <p role="status">Loading saved runs…</p>
          ) : (
            <>
              <div className="run-table-scroll">
                <table className="run-table" aria-label="Saved scenario runs">
                  <thead>
                    <tr>
                      {columns.map(([key, title]) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                          className={
                            key === 'applicationEventCount' || key === 'traceRecordCount' || key === 'runMs'
                              ? 'run-number'
                              : undefined
                          }
                        >
                          <button
                            type="button"
                            onClick={() => setSort({ key, descending: sort.key === key && !sort.descending })}
                          >
                            {title}{' '}
                            <span aria-hidden="true">{sort.key === key ? (sort.descending ? '↓' : '↑') : '↕'}</span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((entry) => (
                      <tr key={entry.file} data-selected={entry.file === selectedFile}>
                        <td>
                          <button
                            type="button"
                            className="run-open"
                            aria-pressed={entry.file === selectedFile}
                            title={entry.file}
                            onClick={() => {
                              onSelectedFileChange(entry.file)
                              onLoad(entry.file)
                            }}
                          >
                            {entry.scenarioId}
                          </button>
                          <span className="run-detail" title={entry.label}>
                            {entry.label
                              .split(' · ')
                              .filter(
                                (part) =>
                                  ![
                                    entry.scenarioId,
                                    entry.profile,
                                    entry.backend,
                                    'BRANCH',
                                    'BASELINE',
                                    'CANDIDATE',
                                  ].includes(part),
                              )
                              .join(' · ')}
                          </span>
                        </td>
                        <td>
                          <span className="run-target">{targetName(entry)}</span>
                          <code className="run-detail" title={entry.sourceRevision}>
                            {displaySourceRevision(entry.sourceRevision).compact}
                          </code>
                        </td>
                        <td>{entry.profile}</td>
                        <td className="run-muted">{entry.backend}</td>
                        <td className="run-number">{entry.applicationEventCount.toLocaleString('en-US')}</td>
                        <td className="run-number">{entry.traceRecordCount.toLocaleString('en-US')}</td>
                        <td>
                          <span className={`run-result run-result-${entry.status}`}>
                            {entry.status === 'passed' ? '✓ Passed' : '× Failed'}
                          </span>
                        </td>
                        <td
                          className="run-number"
                          title="Controller run start to correctness completion. Failed runs have no time to pass."
                        >
                          {formatDuration(entry.timings?.runMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {visible.length === 0 && <p className="run-empty">No runs match these filters.</p>}
            </>
          )}
        </section>
      )}
    </div>
  )
}

export const ViewerHeader = ({
  title,
  summary,
  provenance,
  children,
}: {
  readonly title: string
  readonly summary: string
  readonly provenance?: string
  readonly children?: ReactNode
}) => (
  <header className="toolbar">
    <div className="toolbar-copy">
      <h1>{title}</h1>
      <p className="summary">{summary}</p>
      {provenance === undefined ? null : <p className="provenance">{provenance}</p>}
    </div>
    {children}
  </header>
)
