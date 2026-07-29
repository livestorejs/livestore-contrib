import * as GDG from '@glideapps/glide-data-grid'
import type { Devtools, EventlogMetaRow } from '@livestore/common'
import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { prettyBytes } from '@livestore/utils'
import { Effect, Option, Schema, Stream } from '@livestore/utils/effect'
import React from 'react'
import * as RAC from 'react-aria-components'
import { VscRefresh } from 'react-icons/vsc'

import { useDevtoolsStore } from '../../devtools-store-context.js'
import { eventlogBrowserSchema } from '../../livestore/tables.js'
import { useSessionContext } from '../../session-context.js'
import { useTheme } from '../../theme/mod.js'
import { downloadBlob } from '../../utils/download.ts'
import { getThemeAwareCellColors, useDataGridTheme } from '../DataGridTheme.js'
import { Icons } from '../Icons/mod.js'
import { CreateEventModal } from './CreateEventModal/CreateEventModal.js'

const allColumns = [
  { title: 'Event Number', width: 120, id: 'id', isAdvanced: false },
  {
    title: 'Parent Event Number',
    width: 80,
    id: 'parentSeqNum',
    isAdvanced: true,
  },
  { title: 'Event Name', width: 300, id: 'name', isAdvanced: false },
  { title: 'Args', width: 650, id: 'argsJson', isAdvanced: false },
  { title: 'Client Id', width: 120, id: 'clientId', isAdvanced: false },
  { title: 'Session Id', width: 120, id: 'sessionId', isAdvanced: false },
  { title: 'Schema Hash', width: 200, id: 'schemaHash', isAdvanced: true },
  {
    title: 'Sync Metadata',
    width: 200,
    id: 'syncMetadataJson',
    isAdvanced: true,
  },
] as const

export const EventlogBrowser: React.FC = () => {
  const store = useDevtoolsStore()
  const [{ autoRefresh, showAllColumns, selectedEventTypes }, setState] =
    store.useClientDocument(eventlogBrowserSchema)
  const [reloadDataTrigger, setReloadDataTrigger] = React.useState(0)
  const { apiSession, appSchema } = useSessionContext()
  const [isCreateModalOpen, setIsCreateModalOpen] = React.useState(false)
  const eventDefs = React.useMemo(() => Array.from(appSchema.eventsDefsMap.values()), [appSchema])
  const eventInputSchema = React.useMemo(
    () => LiveStoreEvent.Input.makeSchema(appSchema),
    [appSchema],
  )
  const dataGridTheme = useDataGridTheme()
  const { isDark } = useTheme()
  const cellColors = React.useMemo(() => getThemeAwareCellColors(isDark), [isDark])

  const columns = React.useMemo(
    () => allColumns.filter((c) => c.isAdvanced === false || showAllColumns),
    [showAllColumns],
  )
  const columnKeys = React.useMemo(() => columns.map((c) => c.id), [columns])

  const [databaseFileInfo, setDatabaseFileInfo] = React.useState<
    typeof Devtools.Leader.DatabaseFileInfoRes.Type | undefined
  >(undefined)

  React.useEffect(() => {
    const cancel = Effect.runCallback(
      apiSession.databaseFileInfo.pipe(Effect.tapSync(setDatabaseFileInfo)),
    )
    return () => cancel()
  }, [apiSession])

  const [unfilteredEventlogData, setUnfilteredEventlogData] = React.useState<
    ReadonlyArray<EventlogMetaRow>
  >([])

  const [rowCount, setRowCount] = React.useState(0)

  React.useEffect(() => {
    if (autoRefresh === false) return

    setReloadDataTrigger((_) => _ + 1)

    // Update the eventlog when new events are received
    return apiSession.syncPull.pipe(
      Stream.throttle({
        cost: (messages) => messages.length,
        duration: 20,
        units: 1,
        strategy: 'enforce',
      }),
      Stream.tapSync(() => setReloadDataTrigger((_) => _ + 1)),
      Stream.runDrain,
      Effect.tapCauseLogPretty,
      Effect.runCallback,
    )
  }, [apiSession.syncPull, autoRefresh])

  React.useEffect(() => {
    Promise.all([
      apiSession.eventlog.pipe(Effect.tapCauseLogPretty, Effect.runPromise),
      loadSqlite3Wasm(),
    ]).then(([data, sqlite3]) => {
      const _unused = reloadDataTrigger

      const sqliteDb = sqliteDbFactory({ sqlite3 })({ _tag: 'in-memory' }).pipe(Effect.runSync)
      sqliteDb.import(data)

      const rawRows = sqliteDb.select(
        'SELECT * FROM eventlog ORDER BY seqNumGlobal DESC, seqNumClient DESC LIMIT 1000',
      )
      setUnfilteredEventlogData(rawRows as any)

      const rowCountRes = sqliteDb.select<any>('SELECT COUNT(*) as count FROM eventlog')
      const rowCount = rowCountRes[0]?.count ?? 0
      setRowCount(rowCount)
      // const rows = Schema.decodeUnknownSync(Schema.Array(eventlogMetaTable.schema))(rawRows)
      // setEventlogData(rows)
    })
  }, [apiSession.eventlog, reloadDataTrigger])

  const [searchKey, setSearchKey] = React.useState('')

  type EventlogRow = EventlogMetaRow & {
    id: string
    parentSeqNum: string
  }

  const eventAnalytics = React.useMemo(() => {
    const eventTypeCounts = new Map<
      string,
      { total: number; server: number; client: number; frequency: number[] }
    >()

    // Create frequency buckets (20 buckets for mini histogram)
    const bucketCount = 20
    const maxSeqNum = Math.max(...unfilteredEventlogData.map((r) => r.seqNumGlobal), 0)
    const minSeqNum = Math.min(...unfilteredEventlogData.map((r) => r.seqNumGlobal), 0)
    const bucketSize = Math.max(1, Math.ceil((maxSeqNum - minSeqNum) / bucketCount))

    for (const row of unfilteredEventlogData) {
      const existing = eventTypeCounts.get(row.name) ?? {
        total: 0,
        server: 0,
        client: 0,
        frequency: new Array(bucketCount).fill(0),
      }
      const isClientEvent = row.seqNumClient !== 0

      // Calculate which bucket this event belongs to
      const bucketIndex = Math.min(
        bucketCount - 1,
        Math.floor((row.seqNumGlobal - minSeqNum) / bucketSize),
      )

      const newFrequency = [...existing.frequency]
      newFrequency[bucketIndex]++

      eventTypeCounts.set(row.name, {
        total: existing.total + 1,
        server: existing.server + (isClientEvent ? 0 : 1),
        client: existing.client + (isClientEvent ? 1 : 0),
        frequency: newFrequency,
      })
    }

    return Array.from(eventTypeCounts.entries())
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.total - a.total) // Sort by total count descending within each group
  }, [unfilteredEventlogData])

  const eventlogData = React.useMemo<ReadonlyArray<EventlogRow>>(() => {
    const ROOT_ROW: EventlogRow = {
      seqNumGlobal: EventSequenceNumber.Global.make(0),
      seqNumClient: EventSequenceNumber.Client.make(0),
      seqNumRebaseGeneration: 0,
      parentSeqNumGlobal: EventSequenceNumber.Global.make(0),
      parentSeqNumClient: EventSequenceNumber.Client.make(0),
      parentSeqNumRebaseGeneration: 0,
      name: 'Root',
      id: 'e0 (Root)',
      parentSeqNum: 'e0 (Root)',
      argsJson: '{}',
      sessionId: '',
      clientId: '',
      schemaHash: 0,
      syncMetadataJson: Option.none(),
    }
    const map = (row: EventlogMetaRow) => ({
      ...row,
      id:
        (row.seqNumClient > 0 ? '  ' : '') +
        EventSequenceNumber.Client.toString(
          EventSequenceNumber.Client.Composite.make({
            global: row.seqNumGlobal,
            client: row.seqNumClient,
            rebaseGeneration: row.seqNumRebaseGeneration,
          }),
        ),
      parentSeqNum: EventSequenceNumber.Client.toString(
        EventSequenceNumber.Client.Composite.make({
          global: row.parentSeqNumGlobal,
          client: row.parentSeqNumClient,
          rebaseGeneration: row.parentSeqNumRebaseGeneration,
        }),
      ),
    })

    let filteredData = unfilteredEventlogData

    // Filter by search key
    if (searchKey.trim() !== '') {
      filteredData = filteredData.filter((row) =>
        row.name.toLowerCase().includes(searchKey.toLowerCase()),
      )
    }

    // Filter by event types
    if (selectedEventTypes.length > 0 && selectedEventTypes.length < 2) {
      if (selectedEventTypes.includes('server') && !selectedEventTypes.includes('client')) {
        filteredData = filteredData.filter((row) => row.seqNumClient === 0)
      } else if (selectedEventTypes.includes('client') && !selectedEventTypes.includes('server')) {
        filteredData = filteredData.filter((row) => row.seqNumClient !== 0)
      }
    }

    return [...filteredData.map(map), ROOT_ROW]
  }, [unfilteredEventlogData, searchKey, selectedEventTypes])

  // const tableData = React.useMemo(() => [], [])

  const getCellContent = React.useCallback(
    (cell: GDG.Item): GDG.GridCell => {
      const [col, row] = cell
      const dataRow = eventlogData[row]
      const columnKey = columnKeys[col]!

      const cellData = dataRow?.[columnKey]
      const cellDataStr =
        columnKey === 'argsJson' ? toKvString(JSON.parse(cellData)) : (cellData?.toString() ?? '')

      const isLocalMutation = dataRow?.seqNumClient !== 0

      return {
        kind: GDG.GridCellKind.Text,
        allowOverlay: true,
        readonly: false,
        displayData: cellDataStr,
        data: cellData,
        copyData: cellData,
        themeOverride: {
          textDark: cellDataStr === '__NULL__' ? cellColors.textNull : cellColors.textDark,
          ...(isLocalMutation && { bgCell: cellColors.bgMutation }),
        },
      }
    },
    [eventlogData, columnKeys, cellColors],
  )

  const handleCreateEvent = React.useCallback(
    async ({ name, args }: { name: string; args: Record<string, unknown> }) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeUnknownEffect(eventInputSchema)({ name, args })
        yield* apiSession.commitEvent(encoded)
        setReloadDataTrigger((_) => _ + 1)
      }).pipe(
        Effect.withSpan('@livestore/devtools-react/EventlogBrowser/createEvent'),
        Effect.tapCauseLogPretty,
        Effect.runPromise,
      ),
    [apiSession, eventInputSchema],
  )

  return (
    <div className="flex w-full h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs border-b border-devtools-border/30">
        <div className="flex items-center space-x-2">
          <div className="text-devtools-text font-medium">{rowCount} events</div>
          <RAC.MenuTrigger>
            <RAC.Button className="text-devtools-text-secondary hover:text-devtools-focus p-1 rounded hover:bg-devtools-surface-hover">
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="opacity-60 hover:opacity-100"
              >
                <title>Event Analytics</title>
                <rect x="2" y="6" width="2" height="6" rx="1" />
                <rect x="5" y="4" width="2" height="8" rx="1" />
                <rect x="8" y="2" width="2" height="10" rx="1" />
                <rect x="11" y="5" width="2" height="7" rx="1" />
              </svg>
            </RAC.Button>
            <RAC.Popover className="bg-devtools-surface border border-devtools-border rounded-md shadow-lg min-w-[300px] max-w-[400px] z-50">
              <EventAnalyticsTooltip analytics={eventAnalytics} isDark={isDark} />
            </RAC.Popover>
          </RAC.MenuTrigger>
        </div>
        <RAC.Button
          onPress={() => setIsCreateModalOpen(true)}
          className="flex items-center gap-1 rounded-md border border-devtools-border bg-devtools-surface px-2 py-1 text-xs font-medium text-devtools-text hover:bg-devtools-surface-hover"
        >
          <span className="text-sm">+</span>
          <span>Create event</span>
        </RAC.Button>
        <button
          type="button"
          onClick={() => setReloadDataTrigger((_) => _ + 1)}
          className="text-devtools-text-secondary hover:text-devtools-focus p-1 rounded hover:bg-devtools-surface-hover"
          title="Reload"
        >
          <VscRefresh size={16} />
        </button>
        {databaseFileInfo && (
          <button
            type="button"
            onClick={() =>
              apiSession.eventlog.pipe(
                Effect.tapSync((data) =>
                  downloadBlob(data, databaseFileInfo.eventlog.persistenceInfo.fileName),
                ),
                Effect.tapCauseLogPretty,
                Effect.runPromise,
              )
            }
            className="text-devtools-text-secondary hover:text-devtools-focus p-1 rounded hover:bg-devtools-surface-hover"
            title={`Download Eventlog (${prettyBytes(databaseFileInfo.eventlog.fileSize)})`}
          >
            <Icons.ChromeDevtools.Download className="w-5 h-5" />
          </button>
        )}
        <input
          type="text"
          placeholder="Search by event name..."
          className="rounded-md px-2 py-1 w-[240px] border border-devtools-border focus:border-devtools-focus bg-devtools-surface text-devtools-text text-xs"
          value={searchKey}
          onChange={(e) => setSearchKey(e.target.value)}
        />
        <label className="flex items-center space-x-1">
          <input
            type="checkbox"
            className=""
            checked={autoRefresh}
            onChange={(e) => setState({ autoRefresh: e.target.checked })}
          />
          <span className="text-devtools-text">Auto Reload</span>
        </label>
        <label className="flex items-center space-x-1">
          <input
            type="checkbox"
            className=""
            checked={showAllColumns}
            onChange={(e) => setState({ showAllColumns: e.target.checked })}
          />
          <span className="text-devtools-text">Show advanced fields</span>
        </label>
        <EventTypeFilter
          selectedEventTypes={selectedEventTypes}
          onChange={(types) => setState({ selectedEventTypes: types })}
          isDark={isDark}
        />
      </div>
      <div className="flex-1 overflow-hidden">
        <GDG.DataEditor
          {...{
            getCellContent,
            columns,
            rows: eventlogData.length,
            smoothScrollX: true,
            smoothScrollY: true,
            // onColumnResize,
            getCellsForSelection: true,
            // onHeaderClicked: (colIndex) => {
            //   const colName = columnKeys[colIndex]!
            //   setState.orderByColumn(colName)
            //   setState.orderByDirection(orderByDirection === 'asc' ? 'desc' : 'asc')
            // },
            // gridSelection,
            // onGridSelectionChange: (sel) => {
            //   sel.current ? setSelectedCell(sel.current.cell) : setSelectedCell(undefined)
            //   setGridSelection(sel)
            // },
            maxColumnWidth: 1000,
            width: '100%',
            height: '100%',
            rowHeight: 24,
            headerHeight: 28,
            theme: dataGridTheme,
          }}
        />
      </div>
      <CreateEventModal
        isOpen={isCreateModalOpen}
        onOpenChange={setIsCreateModalOpen}
        eventDefs={eventDefs}
        onSubmit={handleCreateEvent}
      />
    </div>
  )
}

type EventAnalytic = {
  name: string
  total: number
  server: number
  client: number
  frequency: number[]
}

type EventAnalyticsTooltipProps = {
  analytics: EventAnalytic[]
  isDark: boolean
}

const MiniHistogram: React.FC<{
  frequency: number[]
  width?: number
  height?: number
  color?: string
}> = ({ frequency, width = 60, height = 20, color = '#666' }) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size
    canvas.width = width
    canvas.height = height

    // Clear canvas
    ctx.clearRect(0, 0, width, height)

    if (frequency.length === 0) return

    const maxValue = Math.max(...frequency, 1)
    const barWidth = width / frequency.length

    ctx.fillStyle = color

    frequency.forEach((value, index) => {
      const barHeight = (value / maxValue) * height
      const x = index * barWidth
      const y = height - barHeight

      ctx.fillRect(x, y, Math.max(1, barWidth - 0.5), barHeight)
    })
  }, [frequency, width, height, color])

  return <canvas ref={canvasRef} className="rounded-sm" />
}

const EventAnalyticsTooltip: React.FC<EventAnalyticsTooltipProps> = ({ analytics, isDark }) => {
  const groupedAnalytics = React.useMemo(() => {
    const syncedOnly = analytics.filter((e) => e.server > 0 && e.client === 0)
    const clientOnly = analytics.filter((e) => e.server === 0 && e.client > 0)
    const mixed = analytics.filter((e) => e.server > 0 && e.client > 0)

    return { syncedOnly, clientOnly, mixed }
  }, [analytics])

  const renderEventGroup = (events: EventAnalytic[], title: string, color?: string) => {
    if (events.length === 0) return null

    return (
      <div className="mb-4 last:mb-0">
        <div className="text-xs font-medium mb-2 flex items-center space-x-2">
          <span className="text-devtools-text-secondary">{title}</span>
          <span className="text-devtools-text-secondary">({events.length})</span>
        </div>
        <div className="space-y-2 pl-2">
          {events.map((event) => (
            <div key={event.name} className="py-1">
              <div className="flex items-center justify-between mb-1">
                <div className="flex-1 min-w-0">
                  <div
                    className="text-xs font-medium text-devtools-text truncate"
                    style={color ? { color } : {}}
                  >
                    {event.name}
                  </div>
                </div>
                <div className="text-sm font-medium text-devtools-text ml-3">{event.total}</div>
              </div>
              <div className="flex justify-start">
                <MiniHistogram
                  frequency={event.frequency}
                  color={color || (isDark ? '#666' : '#999')}
                  width={80}
                  height={16}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="text-sm font-medium text-devtools-text mb-3 border-b border-devtools-border pb-2">
        Event Analytics
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {analytics.length === 0 ? (
          <div className="text-xs text-devtools-text-secondary italic">No events found</div>
        ) : (
          <>
            {renderEventGroup(groupedAnalytics.syncedOnly, 'Synced events')}
            {renderEventGroup(
              groupedAnalytics.clientOnly,
              'Client-only events',
              isDark ? '#FDD633' : '#F9AB00',
            )}
            {renderEventGroup(groupedAnalytics.mixed, 'Mixed events')}
          </>
        )}
      </div>
      <div className="mt-3 pt-2 border-t border-devtools-border text-xs text-devtools-text-secondary">
        Total: {analytics.reduce((sum, event) => sum + event.total, 0)} events
      </div>
    </div>
  )
}

type EventTypeFilterProps = {
  selectedEventTypes: readonly ('server' | 'client')[]
  onChange: (types: ('server' | 'client')[]) => void
  isDark: boolean
}

const EventTypeFilter: React.FC<EventTypeFilterProps> = ({
  selectedEventTypes,
  onChange,
  isDark,
}) => {
  const handleToggle = (type: 'server' | 'client') => {
    if (selectedEventTypes.includes(type)) {
      // If removing and it's the only one selected, switch to the other type
      const newTypes =
        selectedEventTypes.length === 1
          ? [type === 'server' ? 'client' : 'server']
          : selectedEventTypes.filter((t) => t !== type)
      onChange(newTypes as ('server' | 'client')[])
    } else {
      onChange([...selectedEventTypes, type] as ('server' | 'client')[])
    }
  }

  return (
    <RAC.MenuTrigger>
      <RAC.Button className="flex items-center space-x-2 px-2 py-1 text-xs border border-devtools-border rounded-md bg-devtools-surface text-devtools-text hover:bg-devtools-surface-hover">
        {selectedEventTypes.length === 2 ? (
          <span>All events</span>
        ) : (
          <div className="flex items-center space-x-1">
            {selectedEventTypes.includes('server') && (
              <>
                <div className="w-3 h-3 bg-devtools-text rounded-sm" />
                <span>Server events</span>
              </>
            )}
            {selectedEventTypes.includes('client') && (
              <>
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: isDark ? '#FDD633' : '#F9AB00' }}
                />
                <span style={{ color: isDark ? '#FDD633' : '#F9AB00' }}>Client-only events</span>
              </>
            )}
          </div>
        )}
        <span className="text-devtools-text-secondary text-[10px]">▼</span>
      </RAC.Button>
      <RAC.Popover className="bg-devtools-surface border border-devtools-border rounded-md shadow-lg min-w-[160px] z-50">
        <RAC.Menu className="py-1">
          <RAC.MenuItem
            onAction={() => handleToggle('server')}
            className="flex items-center space-x-2 px-3 py-2 text-xs text-devtools-text hover:bg-devtools-surface-hover cursor-pointer"
          >
            <div className="w-4 h-4 border border-devtools-border rounded-sm flex items-center justify-center bg-devtools-surface">
              {selectedEventTypes.includes('server') && (
                <div className="w-2 h-2 bg-devtools-text rounded-sm" />
              )}
            </div>
            <span>Server events</span>
          </RAC.MenuItem>
          <RAC.MenuItem
            onAction={() => handleToggle('client')}
            className="flex items-center space-x-2 px-3 py-2 text-xs hover:bg-devtools-surface-hover cursor-pointer"
            style={{ color: isDark ? '#FDD633' : '#F9AB00' }}
          >
            <div className="w-4 h-4 border border-devtools-border rounded-sm flex items-center justify-center bg-devtools-surface">
              {selectedEventTypes.includes('client') && (
                <div
                  className="w-2 h-2 rounded-sm"
                  style={{ backgroundColor: isDark ? '#FDD633' : '#F9AB00' }}
                />
              )}
            </div>
            <span>Client-only events</span>
          </RAC.MenuItem>
        </RAC.Menu>
      </RAC.Popover>
    </RAC.MenuTrigger>
  )
}

const toKvString = (obj: any): string => {
  if (obj === null) return '__NULL__'

  if (Array.isArray(obj)) {
    return JSON.stringify(obj)
  }

  return (
    '{ ' +
    Object.entries(obj)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ') +
    ' }'
  )
}
