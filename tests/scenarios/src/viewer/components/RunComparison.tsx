/* eslint-disable react-perf/jsx-no-new-function-as-prop -- Local comparison controls. */
import { useState } from 'react'

import { formatDuration, timingMetrics, type TimingMetric } from '../../performance.ts'
import { compareRuns } from '../../run-comparison.ts'
import { displaySourceRevision } from '../../source-revision.ts'
import type { ArtifactCatalog } from '../artifact-io.ts'

type Side = ReturnType<typeof compareRuns>[number]['baseline']
const TimingCell = ({ side }: { readonly side: Side }) => (
  <td className="run-number">
    {formatDuration(side.stats?.median)}
    {side.stats && side.stats.count > 1 && (
      <span className="run-detail">
        {formatDuration(side.stats.min)}–{formatDuration(side.stats.max)}
      </span>
    )}
  </td>
)

export const RunComparison = ({
  catalog,
  onLoad,
}: {
  readonly catalog: ArtifactCatalog | undefined
  readonly onLoad: (file: string) => void
}) => {
  const [scope, setScope] = useState<string>()
  const [baseline, setBaseline] = useState('')
  const [candidate, setCandidate] = useState('')
  const [metric, setMetric] = useState<TimingMetric>('workloadMs')
  const [query, setQuery] = useState('')
  const [baselineFile, setBaselineFile] = useState('')
  const [candidateFile, setCandidateFile] = useState('')
  const campaigns = catalog?.campaigns ?? []
  const activeScope = scope ?? campaigns[0]?.id ?? ''
  const campaign = campaigns.find((c) => c.id === activeScope)
  const entries = (catalog?.entries ?? []).filter((e) => (activeScope ? e.benchmark?.id === activeScope : !e.benchmark))
  const revisions = [...new Set(entries.map((e) => e.sourceRevision))]
  const left = revisions.includes(baseline) ? baseline : (campaign?.baseline ?? revisions[0] ?? '')
  const right = revisions.includes(candidate)
    ? candidate
    : (campaign?.candidate ?? revisions.find((r) => r !== left) ?? '')
  const rows = compareRuns(
    entries.filter((e) =>
      e.sourceRevision === left ? !baselineFile || e.file === baselineFile : !candidateFile || e.file === candidateFile,
    ),
    left,
    right,
    metric,
  ).filter((row) => `${row.entry.scenarioId} ${row.entry.profile}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <section aria-label="Run comparison" className="run-browser">
      <div className="run-filters">
        <select
          aria-label="Comparison campaign"
          value={activeScope}
          onChange={(e) => {
            setScope(e.currentTarget.value)
            setBaseline('')
            setCandidate('')
            setBaselineFile('')
            setCandidateFile('')
          }}
        >
          <option value="">Saved runs · exploratory</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.startedAt.replace('T', ' ').slice(0, 19)} · {c.status}
            </option>
          ))}
        </select>
        <label>
          Baseline{' '}
          <select
            aria-label="Baseline revision"
            value={left}
            onChange={(e) => {
              setBaseline(e.currentTarget.value)
              setBaselineFile('')
            }}
          >
            <option value="" disabled>
              Select revision
            </option>
            {revisions.map((r) => (
              <option key={r} value={r}>
                {displaySourceRevision(r).compact}
              </option>
            ))}
          </select>
        </label>
        <label>
          Candidate{' '}
          <select
            aria-label="Candidate revision"
            value={right}
            onChange={(e) => {
              setCandidate(e.currentTarget.value)
              setCandidateFile('')
            }}
          >
            <option value="" disabled>
              Select revision
            </option>
            {revisions.map((r) => (
              <option key={r} value={r}>
                {displaySourceRevision(r).compact}
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label="Timing metric"
          value={metric}
          onChange={(e) => setMetric(e.currentTarget.value as TimingMetric)}
        >
          {timingMetrics.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label="Search comparisons"
          placeholder="Filter scenarios or profiles…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <details className="comparison-note">
        <summary>Choose individual runs</summary>
        <div className="run-filters">
          <select
            aria-label="Baseline sample"
            value={baselineFile}
            onChange={(e) => setBaselineFile(e.currentTarget.value)}
          >
            <option value="">All baseline samples</option>
            {entries
              .filter((e) => e.sourceRevision === left)
              .map((e) => (
                <option key={e.file} value={e.file}>
                  {e.scenarioId} · {e.profile} · {e.benchmark ? `sample ${e.benchmark.iteration}` : e.file} · {e.status}
                </option>
              ))}
          </select>
          <select
            aria-label="Candidate sample"
            value={candidateFile}
            onChange={(e) => setCandidateFile(e.currentTarget.value)}
          >
            <option value="">All candidate samples</option>
            {entries
              .filter((e) => e.sourceRevision === right)
              .map((e) => (
                <option key={e.file} value={e.file}>
                  {e.scenarioId} · {e.profile} · {e.benchmark ? `sample ${e.benchmark.iteration}` : e.file} · {e.status}
                </option>
              ))}
          </select>
        </div>
      </details>
      <p className="comparison-note">
        {campaign
          ? 'Paired campaign · warmups excluded. '
          : 'Exploratory comparison · machine, dependencies, and run order may differ. '}
        Medians and min–max ranges use passing runs only. A timing change is shown only when both sides pass every
        sample. Negative change means faster.
      </p>
      <p className="comparison-note">
        {metric === 'runMs'
          ? 'Controller run start → correctness completed; includes client startup and checks, excludes artifact writing and launcher setup.'
          : metric === 'startupMs'
            ? 'Controller run start → all initial clients created.'
            : metric === 'workloadMs'
              ? 'First action → terminal settlement; includes authored waits and full observation overhead.'
              : 'Longest fault removal → confirmed recovery; not available without a completed connectivity recovery.'}{' '}
        Settlement uses 100 ms polling plus observation time; small differences may be noise.
      </p>
      {campaign && (
        <p className="comparison-note">
          {campaign.environment.platform}/{campaign.environment.arch} · Node {campaign.environment.node} ·{' '}
          {campaign.environment.cpu}
        </p>
      )}
      {campaign?.status !== 'complete' && campaign && (
        <p role="alert" className="comparison-note">
          Campaign {campaign.status}. Timing comparisons are withheld. {campaign.error}
        </p>
      )}
      {!left || !right || left === right ? (
        <p className="run-empty">Choose two different revisions to compare.</p>
      ) : (
        <div className="run-table-scroll">
          <table className="run-table" aria-label="Baseline and candidate comparison">
            <thead>
              <tr>
                <th scope="col">Scenario / profile</th>
                <th scope="col">Baseline passed</th>
                <th scope="col">Candidate passed</th>
                <th scope="col">Baseline median</th>
                <th scope="col">Candidate median</th>
                <th scope="col">Change</th>
                <th scope="col">Inspect</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    {row.entry.scenarioId}
                    <span className="run-detail">
                      {row.entry.profile} · {row.entry.backend}
                    </span>
                    <span className="run-detail">
                      {row.entry.label
                        .split(' · ')
                        .filter(
                          (p) =>
                            ![
                              row.entry.scenarioId,
                              row.entry.profile,
                              row.entry.backend,
                              'BASELINE',
                              'BRANCH',
                              'CANDIDATE',
                            ].includes(p) && !p.startsWith('sample '),
                        )
                        .join(' · ')}
                    </span>
                  </td>
                  <td>
                    {row.baseline.passed} / {row.baseline.runs.length}
                  </td>
                  <td>
                    {row.candidate.passed} / {row.candidate.runs.length}
                  </td>
                  <TimingCell side={row.baseline} />
                  <TimingCell side={row.candidate} />
                  <td>
                    {row.delta === undefined ? (
                      <span className="run-muted">
                        {!row.baseline.runs.length || !row.candidate.runs.length
                          ? 'Unmatched workload'
                          : row.baseline.passed !== row.baseline.runs.length ||
                              row.candidate.passed !== row.candidate.runs.length
                            ? 'Correctness failed'
                            : 'Not comparable'}
                      </span>
                    ) : (
                      <span>
                        {row.delta > 0 ? '+' : ''}
                        {row.delta.toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td>
                    <details>
                      <summary>Runs</summary>
                      <div className="comparison-runs">
                        {(['baseline', 'candidate'] as const).map((side) => (
                          <div key={side}>
                            <strong>{side}</strong>
                            {row[side].runs.map((run, i) => (
                              <button key={run.file} type="button" onClick={() => onLoad(run.file)}>
                                {run.benchmark?.iteration ?? i + 1} · {run.status} ·{' '}
                                {formatDuration(run.timings?.[metric])}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="run-empty">No matching scenarios.</p>}
        </div>
      )}
    </section>
  )
}
