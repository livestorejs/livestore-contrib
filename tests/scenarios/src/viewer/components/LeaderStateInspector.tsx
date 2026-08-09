import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type { ScenarioRunArtifact } from '../../model.ts'
import { requestLeaderStateMaterialization } from '../leader-state-client.ts'
import {
  type LeaderStateSource,
  type ReconstructedLeaderState,
  type ReconstructedTable,
  type ReconstructedValue,
  selectLeaderStateSource,
} from '../leader-state.ts'
import { StatusBadge } from './Primitives.tsx'

type ReconstructionStatus =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'loading'; readonly source: LeaderStateSource }
  | { readonly _tag: 'success'; readonly state: ReconstructedLeaderState }
  | { readonly _tag: 'error'; readonly source: LeaderStateSource; readonly message: string }

const defaultDrawerHeight = 380
const minimumDrawerHeight = 190
const resizeStep = 24
const maximumDrawerHeight = (): number => Math.max(minimumDrawerHeight, window.innerHeight - 24)

export const LeaderStateInspector = ({
  artifact,
  clientId,
  cursorIndex,
  playing,
  onClose,
}: {
  readonly artifact: ScenarioRunArtifact
  readonly clientId: string
  readonly cursorIndex: number
  readonly playing: boolean
  readonly onClose: () => void
}) => {
  const source = useMemo(
    () =>
      selectLeaderStateSource({
        applicationId: artifact.descriptor.applicationId,
        clientId,
        cursorIndex,
        trace: artifact.trace,
      }),
    [artifact, clientId, cursorIndex],
  )
  const [status, setStatus] = useState<ReconstructionStatus>({ _tag: 'idle' })
  const [drawerHeight, setDrawerHeight] = useState(defaultDrawerHeight)
  const [closing, setClosing] = useState(false)
  const resizeOrigin = useRef<{ readonly pointerY: number; readonly height: number } | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (source === undefined || playing === true) {
      setStatus({ _tag: 'idle' })
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setStatus({ _tag: 'loading', source })
      void requestLeaderStateMaterialization(source)
        .then((state) => {
          if (active === true) setStatus({ _tag: 'success', state })
        })
        .catch((cause: unknown) => {
          if (active === true) {
            setStatus({
              _tag: 'error',
              source,
              message: cause instanceof Error ? cause.message : String(cause),
            })
          }
        })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [playing, source])

  const currentStatus =
    source !== undefined &&
    status._tag !== 'idle' &&
    (status._tag === 'success' ? status.state.source.recordIndex : status.source.recordIndex) === source.recordIndex
      ? status
      : ({ _tag: 'idle' } as const)

  const resizeDrawer = useCallback(
    (height: number): void => setDrawerHeight(Math.max(minimumDrawerHeight, Math.min(maximumDrawerHeight(), height))),
    [],
  )
  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      resizeOrigin.current = { pointerY: event.clientY, height: drawerHeight }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [drawerHeight],
  )
  const continueResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (resizeOrigin.current === undefined) return
      resizeDrawer(resizeOrigin.current.height + event.clientY - resizeOrigin.current.pointerY)
    },
    [resizeDrawer],
  )
  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    resizeOrigin.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId) === true)
      event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])
  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'ArrowUp') resizeDrawer(drawerHeight - resizeStep)
      if (event.key === 'ArrowDown') resizeDrawer(drawerHeight + resizeStep)
    },
    [drawerHeight, resizeDrawer],
  )
  const requestClose = useCallback((): void => {
    if (closing === true) return
    setClosing(true)
    closeTimer.current = window.setTimeout(onClose, 180)
  }, [closing, onClose])

  const style = useMemo(
    () => ({ '--leader-state-drawer-height': `${drawerHeight}px` }) as CSSProperties,
    [drawerHeight],
  )
  return (
    <article
      className={`leader-state-drawer${closing === true ? ' closing' : ''}`}
      aria-label={`${clientId} reconstructed Leader State`}
      style={style}
    >
      <div className="leader-state-drawer-body">
        {source === undefined ? (
          <p className="leader-state-message">No Leader observation is recorded at or before this cursor.</p>
        ) : playing === true ? (
          <p className="leader-state-message">Reconstruction waits until timeline playback pauses.</p>
        ) : currentStatus._tag === 'loading' || currentStatus._tag === 'idle' ? (
          <p className="leader-state-message">Materializing recorded Event facts…</p>
        ) : currentStatus._tag === 'error' ? (
          <p className="leader-state-message reconstruction-error">Materialization failed: {currentStatus.message}</p>
        ) : (
          <ReconstructedTables state={currentStatus.state} />
        )}
      </div>
      <div
        aria-label="Resize reconstructed State drawer"
        aria-orientation="horizontal"
        aria-valuemax={maximumDrawerHeight()}
        aria-valuemin={minimumDrawerHeight}
        aria-valuenow={drawerHeight}
        className="leader-state-resize-handle"
        onKeyDown={resizeWithKeyboard}
        onPointerCancel={endResize}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={endResize}
        role="separator"
        tabIndex={0}
      >
        <span />
      </div>
      <footer className="leader-state-status-bar">
        <StatusBadge
          tone={currentStatus._tag === 'error' ? 'bad' : currentStatus._tag === 'success' ? 'good' : 'neutral'}
        >
          {currentStatus._tag}
        </StatusBadge>
        <div className="leader-state-status-summary">
          <strong>{clientId} · Leader</strong>
          {source === undefined ? (
            <span>no observation at cursor</span>
          ) : (
            <>
              <span>replayed record #{source.recordIndex + 1}</span>
              <span>
                {source.observation.localHead}/{source.observation.upstreamHead} heads
              </span>
              <span>{source.observation.pendingCount} pending</span>
              <span>{source.observation.events.length} events</span>
              <span className="leader-state-capture" title={source.captureId ?? 'no source capture'}>
                capture {source.captureId ?? 'none'}
              </span>
            </>
          )}
        </div>
        <button type="button" className="text-button" onClick={requestClose}>
          close
        </button>
      </footer>
    </article>
  )
}

export const ReconstructedTables = ({ state }: { readonly state: ReconstructedLeaderState }) => {
  const [selectedTableName, setSelectedTableName] = useState(state.tables[0]?.name)
  const selectedTable = state.tables.find((table) => table.name === selectedTableName) ?? state.tables[0]
  const selectTable = useCallback((event: ReactChangeEvent<HTMLSelectElement>): void => {
    setSelectedTableName(event.currentTarget.value)
  }, [])

  if (selectedTable === undefined) {
    return <p className="leader-state-message">The Application schema has no user tables.</p>
  }

  return (
    <div className="reconstructed-table-view">
      <header className="reconstructed-table-toolbar">
        <label>
          <span>Table</span>
          <select aria-label="Reconstructed table" value={selectedTable.name} onChange={selectTable}>
            {state.tables.map((table) => (
              <option key={table.name} value={table.name}>
                {table.name}
              </option>
            ))}
          </select>
        </label>
        <span className="reconstructed-table-count">
          {selectedTable.rows.length} {selectedTable.rows.length === 1 ? 'row' : 'rows'}
        </span>
      </header>
      <ReconstructedTableContents table={selectedTable} />
    </div>
  )
}

const ReconstructedTableContents = ({ table }: { readonly table: ReconstructedTable }) => (
  <section className="reconstructed-table" aria-label={`Reconstructed table ${table.name}`}>
    {table.rows.length === 0 ? (
      <p className="leader-state-message">No rows</p>
    ) : (
      <div className="reconstructed-table-scroll">
        <table>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={table.columns.map((column) => displayValue(row[column] ?? null)).join('\u0000')}>
                {table.columns.map((column) => (
                  <td key={column}>{displayValue(row[column] ?? null)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
)

const displayValue = (value: ReconstructedValue): string => {
  if (value === null) return 'null'
  if (typeof value === 'object') return `0x${value.bytesHex}`
  return String(value)
}
