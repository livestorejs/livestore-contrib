/* eslint-disable react-perf/jsx-no-new-function-as-prop -- File and select handlers are local leaf interactions. */
import type { ChangeEvent, ReactNode } from 'react'

import type { ArtifactCatalog } from '../artifact-io.ts'

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
  readonly onLoad: () => void
}) => {
  const handleFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    if (file !== undefined) onFile(file)
  }
  return (
    <div className="controls">
      <label className="file-button">
        open
        <input type="file" accept="application/json,application/gzip,.json,.json.gz" onChange={handleFile} />
      </label>
      <div className="select-control">
        <select
          id="example-artifact"
          aria-label="Saved scenario run"
          value={selectedFile}
          disabled={catalog === undefined || catalog.entries.length === 0}
          onChange={(event) => onSelectedFileChange(event.currentTarget.value)}
        >
          <option value="">{catalogError ?? 'select saved run'}</option>
          {catalog?.entries.map((entry) => (
            <option key={entry.file} value={entry.file}>
              {entry.label} · {entry.applicationEventCount} events · {entry.traceRecordCount} traces
              {entry.status === 'failed' ? ' · FAILED' : ''}
            </option>
          ))}
        </select>
      </div>
      <button type="button" disabled={selectedFile.length === 0} onClick={onLoad}>
        load
      </button>
    </div>
  )
}

export const ViewerHeader = ({
  title,
  summary,
  children,
}: {
  readonly title: string
  readonly summary: string
  readonly children?: ReactNode
}) => (
  <header className="toolbar">
    <div className="toolbar-copy">
      <h1>{title}</h1>
      <p className="summary">{summary}</p>
    </div>
    {children}
  </header>
)
