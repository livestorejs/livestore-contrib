import type * as GDG from '@glideapps/glide-data-grid'
import * as GDGCells from '@glideapps/glide-data-grid-cells'
import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { provideOtel } from '@livestore/common'
import { LiveStoreEvent, State } from '@livestore/common/schema'
import * as LiveStore from '@livestore/livestore'
import * as LiveStoreReact from '@livestore/react'
import { notYetImplemented } from '@livestore/utils'
import {
  Effect,
  Exit,
  pipe,
  ReadonlyArray,
  Result,
  Schema,
  SchemaGetter,
  Scope,
  Stream,
} from '@livestore/utils/effect'
import React from 'react'

import { useDevtoolsStore } from '../../../devtools-store-context.js'
import { dataBrowserDynamicSchema, dataBrowserStaticSchema } from '../../../livestore/tables.js'
import { useSessionContext } from '../../../session-context.js'
import { useTheme } from '../../../theme/mod.js'
import { getThemeAwareCellColors, useDataGridTheme } from '../../DataGridTheme.js'
import { Sqlite } from '../Sqlite.js'
import { DataBrowserGrid } from './grid.js'
import { parseEditedCellValue } from './parseEditedCellValue.ts'
import { sessionIdCellRenderer } from './session-id-cell.js'
import { DataBrowserSidebar, type SidebarItem } from './sidebar.js'
import { useDisplayColumns } from './useDisplayColumns.js'

export const DataBrowser: React.FC = () => {
  const [appStore, setAppStore] = React.useState<LiveStore.Store | undefined>(undefined)
  const { apiSession, appSchema } = useSessionContext()

  React.useEffect(() => {
    const storeScope = Scope.make().pipe(Effect.runSync)

    Effect.gen(function* () {
      const importSnapshot = yield* apiSession.snapshot

      const appStore = yield* LiveStore.createStore({
        schema: appSchema,
        adapter: makeInMemoryAdapter({ importSnapshot }),
        disableDevtools: true,
        storeId: 'devtools-data-browser',
        confirmUnsavedChanges: false,
      }).pipe(provideOtel({}))

      yield* apiSession.syncPull.pipe(
        Stream.tapSync(({ payload }) => {
          if (payload._tag === 'upstream-rebase') {
            // TODO properly implement rebases in devtools
            location.reload()
          } else {
            for (const eventEncoded of payload.newEvents) {
              const eventDecoded = Schema.decodeUnknownSync(
                appStore[LiveStore.StoreInternalsSymbol].eventSchema,
              )(eventEncoded)
              appStore.commit(eventDecoded)
            }
          }
        }),
        Stream.runDrain,
        Effect.tapCauseLogPretty,
        Effect.forkScoped,
      )

      setAppStore(appStore)
    }).pipe(
      Scope.provide(storeScope),
      Effect.tapCauseLogPretty,
      Effect.forkIn(storeScope),
      Effect.runFork,
    )

    return () => {
      Scope.close(storeScope, Exit.void).pipe(Effect.tapCauseLogPretty, Effect.runFork)
      setAppStore(undefined)
    }
  }, [apiSession.syncPull, apiSession.snapshot, appSchema])

  if (appStore === undefined) {
    return <div className="p-2 text-xs">Loading app data...</div>
  }

  return <DataBrowserInner appStore={LiveStoreReact.withReactApi(appStore)} />
}

const DataBrowserInner: React.FC<{
  appStore: LiveStore.Store & LiveStoreReact.ReactApi
}> = ({ appStore }) => {
  useEnsurePortalElementForGDG()
  const dataGridTheme = useDataGridTheme()
  const { isDark } = useTheme()
  const cellColors = React.useMemo(() => getThemeAwareCellColors(isDark), [isDark])
  const { apiSession } = useSessionContext()
  const connectedSessionId = apiSession.clientInfo.sessionId

  const tables = React.useMemo(
    () => appStore.schema.state.sqlite.tables as Map<string, State.SQLite.TableDef>,
    [appStore.schema.state.sqlite.tables],
  )
  const customRenderers = React.useMemo<ReadonlyArray<GDG.CustomRenderer<any>>>(
    () => [
      GDGCells.DropdownCell as GDG.CustomRenderer<any>,
      sessionIdCellRenderer as GDG.CustomRenderer<any>,
    ],
    [],
  )

  const [regularTableNames, clientDocumentTableNames, livestoreTableNames] = React.useMemo<
    [string[], string[], string[]]
  >(() => {
    const allTableNames = Array.from(tables.keys()).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    )
    const [otherTables, livestoreTables] = pipe(
      allTableNames,
      ReadonlyArray.partition((tableName) =>
        tableName.includes('livestore_') ? Result.succeed(tableName) : Result.fail(tableName),
      ),
    )

    // Further split other tables into regular tables and client document tables
    const [clientDocTables, regularTables] = pipe(
      otherTables,
      ReadonlyArray.partition((tableName) => {
        const tableDef = tables.get(tableName)
        return tableDef !== undefined && State.SQLite.tableIsClientDocumentTable(tableDef)
          ? Result.fail(tableName)
          : Result.succeed(tableName)
      }),
    )

    return [regularTables, clientDocTables, livestoreTables]
  }, [tables])

  const store = useDevtoolsStore()

  const allTableNames = React.useMemo(
    () => [...regularTableNames, ...clientDocumentTableNames, ...livestoreTableNames],
    [regularTableNames, clientDocumentTableNames, livestoreTableNames],
  )

  const sessionId = store.sessionId
  const [{ activeTableName, livestoreInternalsExpanded }, setStaticState] = store.useClientDocument(
    dataBrowserStaticSchema,
    sessionId,
  )

  const currentTableDef = React.useMemo(() => {
    // If SQLite Playground is selected, we don't need a table definition
    if (activeTableName === 'SQLitePlayground') {
      return undefined
    }

    const table = tables.get(activeTableName)
    if (table === undefined) {
      if (tables.size > 0) {
        const firstTable =
          regularTableNames[0] ?? clientDocumentTableNames[0] ?? livestoreTableNames[0]
        if (firstTable) {
          setStaticState({ activeTableName: firstTable })
          console.log('Table not found, defaulting to first table:', firstTable)
          return tables.get(firstTable)!
        }
      }
      throw new Error(
        `Table ${activeTableName} not found. Please make sure it exists in the schema.`,
      )
    }
    return table
  }, [
    activeTableName,
    regularTableNames,
    clientDocumentTableNames,
    livestoreTableNames,
    setStaticState,
    tables,
  ])

  const isIntialRender = React.useRef(true)

  // Given `dataBrowserStaticSchema` is a singleton table which needs a static default value,
  // we're setting the activeTableName to the first user-schema table name on the first render.
  if (
    isIntialRender.current &&
    activeTableName.startsWith('__livestore_') &&
    activeTableName !== 'SQLitePlayground'
  ) {
    isIntialRender.current = false
    const firstTable = regularTableNames[0] ?? clientDocumentTableNames[0]
    if (firstTable) {
      setStaticState({ activeTableName: firstTable })
    }
  }

  const defaultColumnName = React.useMemo(
    () => currentTableDef?.sqliteDef.ast.columns[0]?.name ?? 'id',
    [currentTableDef],
  )

  const tableColumns = React.useMemo(
    () =>
      Object.fromEntries(
        currentTableDef?.sqliteDef.ast.columns.map((col) => [col.name, col]) ?? [],
      ),
    [currentTableDef],
  )

  const columnKeys = React.useMemo(() => Object.keys(tableColumns), [tableColumns])

  const hasDerivedMutations = React.useMemo(
    () => (currentTableDef ? State.SQLite.tableIsClientDocumentTable(currentTableDef) : false),
    [currentTableDef],
  )

  // Client document tables with SessionIdSymbol default IDs share the session ID; mark matching rows.
  const isSessionBoundTable = React.useMemo(() => {
    if (!currentTableDef || State.SQLite.tableIsClientDocumentTable(currentTableDef) === false) {
      return false
    }

    const clientDocMeta = currentTableDef?.[State.SQLite.ClientDocumentTableDefSymbol]
    const defaultId = clientDocMeta?.options?.default?.id

    return defaultId === LiveStore.SessionIdSymbol
  }, [currentTableDef])

  const [{ searchKey, orderByColumn, orderByDirection, columnWidths }, setState] =
    store.useClientDocument(dataBrowserDynamicSchema, `${activeTableName}-${sessionId}`, {
      default: { orderByColumn: defaultColumnName },
    })
  const effectiveOrderByColumn = tableColumns[orderByColumn] ? orderByColumn : defaultColumnName
  const orderByClause = `ORDER BY ${effectiveOrderByColumn} ${orderByDirection}`
  const unfilteredTableData = appStore.useQuery(
    activeTableName === 'SQLitePlayground' || !currentTableDef
      ? LiveStore.queryDb<ReadonlyArray<any>>(
          {
            query: 'SELECT 1 WHERE 0',
            schema: Schema.Array(Schema.Struct({})),
            queriedTables: new Set(),
          },
          { deps: [] },
        )
      : LiveStore.queryDb<ReadonlyArray<any>>(
          {
            query: `select * from ${activeTableName} ${orderByClause}`,
            schema: Schema.Array(currentTableDef.rowSchema),
            queriedTables: new Set([activeTableName]),
          },
          {
            deps: [activeTableName, orderByColumn, orderByDirection],
          },
        ),
    { store: appStore },
  )

  const tableData = React.useMemo(() => {
    if (searchKey.trim() === '') return unfilteredTableData

    const searchKeyLower = searchKey.toLowerCase()
    return unfilteredTableData.filter((row) =>
      Object.values(row).some((cell) => cell?.toString().toLowerCase().includes(searchKeyLower)),
    )
  }, [unfilteredTableData, searchKey])

  const tableCounts = appStore.useQuery(
    LiveStore.queryDb(
      () => ({
        query:
          allTableNames.length > 0
            ? allTableNames
                .map(
                  (tableName) =>
                    `SELECT '${tableName}' AS tableName, COUNT(*) AS count FROM ${tableName}`,
                )
                .join(' UNION ')
            : 'SELECT "" AS tableName, 0 AS count WHERE 0',
        queriedTables: new Set(allTableNames),
        schema: Schema.Struct({
          tableName: Schema.String,
          count: Schema.Finite,
        }).pipe(
          Schema.Array,
          Schema.decodeTo(Schema.ReadonlyMap(Schema.String, Schema.Finite), {
            encode: SchemaGetter.transform(() => notYetImplemented(`encode`)),
            decode: SchemaGetter.transform(
              (rows) => new Map(rows.map((row) => [row.tableName, row.count])),
            ),
          }),
        ),
      }),
      { deps: allTableNames },
    ),
  )

  const {
    displayColumns,
    gridColumns,
    defaultColumnWidths,
    effectiveOrderByColumn: _,
  } = useDisplayColumns({
    currentTableDef,
    tableColumns,
    columnKeys,
    tableData,
    columnWidths,
    dataGridTheme,
    isSessionBoundTable,
    hasDerivedMutations,
    defaultColumnName,
    orderByColumn,
    orderByDirection,
  })

  if (Object.keys(defaultColumnWidths).length > 0) {
    setState(({ columnWidths }) => ({
      columnWidths: { ...columnWidths, ...defaultColumnWidths },
    }))
  }

  const onColumnResize = React.useCallback(
    (column: GDG.GridColumn, newSize: number) => {
      return setState(({ columnWidths }) => ({
        columnWidths: { ...columnWidths, [column.id as any]: newSize },
      }))
    },
    [setState],
  )

  const handleHeaderClicked = React.useCallback(
    (colIndex: number) => {
      const displayColumn = displayColumns[colIndex]
      if (!displayColumn || displayColumn.kind !== 'base') return

      const colName = displayColumn.key
      setState(({ orderByDirection }) => ({
        orderByColumn: colName,
        orderByDirection: orderByDirection === 'asc' ? 'desc' : 'asc',
      }))
    },
    [displayColumns, setState],
  )

  const onCellEdited = React.useCallback(
    ([col, row]: GDG.Item, cell: GDG.EditableGridCell) =>
      Effect.gen(function* () {
        if (!currentTableDef || State.SQLite.tableIsClientDocumentTable(currentTableDef) === false)
          return

        const displayColumn = displayColumns[col]
        if (!displayColumn) return

        const rowDataDecoded = tableData[row]! as Record<string, any>
        const currentValue = (rowDataDecoded.value ?? {}) as Record<string, any>

        let updatedValue: any

        if (displayColumn.kind === 'value-field') {
          const parsedValue = parseEditedCellValue({
            cell,
            columnSchemaAst: displayColumn.fieldAst,
            existingValue: currentValue[displayColumn.fieldName],
          })
          updatedValue = { ...currentValue, [displayColumn.fieldName]: parsedValue }
        } else {
          if (displayColumn.key === 'id') {
            return
          }

          const parsedValue = parseEditedCellValue({
            cell,
            columnSchemaAst: displayColumn.schemaAst,
            existingValue: currentValue,
          })
          updatedValue = parsedValue
        }

        const eventDecoded = currentTableDef.set(updatedValue, rowDataDecoded.id)

        const eventInputSchema = LiveStoreEvent.Input.makeSchema(appStore.schema)
        const eventEncoded = yield* Schema.encodeUnknownEffect(
          eventInputSchema,
          // TODO remove options once Effect schema bug is fixed
          { onExcessProperty: 'error' },
        )(eventDecoded)

        yield* apiSession.commitEvent(eventEncoded)
      }).pipe(
        Effect.withSpan('@livestore/devtools-react/DataBrowser/onCellEdited'),
        Effect.tapCauseLogPretty,
        Effect.runPromise,
      ),
    [currentTableDef, tableData, displayColumns, appStore.schema, apiSession],
  )

  const tableItems: SidebarItem[] = regularTableNames.map((tableName) => ({
    name: `${tableName} (${tableCounts.get(tableName)})`,
    isSelected: activeTableName === tableName,
    onClick: () => setStaticState({ activeTableName: tableName }),
  }))

  const clientDocumentItems: SidebarItem[] = clientDocumentTableNames.map((tableName) => ({
    name: `${tableName} (${tableCounts.get(tableName)})`,
    isSelected: activeTableName === tableName,
    onClick: () => setStaticState({ activeTableName: tableName }),
  }))

  const livestoreItems: SidebarItem[] = livestoreTableNames.map((tableName) => ({
    name: `${tableName} (${tableCounts.get(tableName)?.toLocaleString()})`,
    isSelected: activeTableName === tableName,
    onClick: () => setStaticState({ activeTableName: tableName }),
  }))

  const sqlitePlaygroundItem: SidebarItem = {
    name: 'SQLite Playground',
    isSelected: activeTableName === 'SQLitePlayground',
    onClick: () => setStaticState({ activeTableName: 'SQLitePlayground' }),
  }

  return (
    <div
      role="application"
      className="space-y-4 h-full flex flex-col"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-grow overflow-hidden divide-x divide-devtools-divider">
        <DataBrowserSidebar
          tableItems={tableItems}
          clientDocumentItems={clientDocumentItems}
          livestoreItems={livestoreItems}
          sqlitePlaygroundItem={sqlitePlaygroundItem}
          livestoreInternalsExpanded={livestoreInternalsExpanded}
          onToggleLivestoreInternals={() =>
            setStaticState({
              livestoreInternalsExpanded: !livestoreInternalsExpanded,
            })
          }
        />
        <div className="flex flex-col w-full h-full">
          {activeTableName === 'SQLitePlayground' ? (
            <Sqlite />
          ) : (
            <>
              <div className="flex-shrink h-[30px] px-1 py-px space-x-1 flex">
                <input
                  type="text"
                  placeholder="Search..."
                  className="rounded-md px-1 py-px my-1 w-[240px] border border-devtools-border focus:border-devtools-focus bg-devtools-surface text-devtools-text text-xs"
                  value={searchKey}
                  onChange={(e) => setState({ searchKey: e.target.value })}
                />
                {/* <DevUi.ButtonXs
                  className="bg-white rounded"
                  onClick={() => {
                    if (!confirm('Are you sure you want to truncate this table?')) return

                    store.commit(
                      LiveStore.rawSqlEvent({
                        sql: `delete from ${activeTableName}`,
                        writeTables: new Set([activeTableName]),
                      }),
                    )
                  }}
                >
                  Truncate Table
                </DevUi.ButtonXs> */}
              </div>
              <DataBrowserGrid
                displayColumns={displayColumns}
                gridColumns={gridColumns}
                tableData={tableData}
                cellColors={cellColors}
                hasDerivedMutations={hasDerivedMutations}
                isSessionBoundTable={isSessionBoundTable}
                connectedSessionId={connectedSessionId}
                dataGridTheme={dataGridTheme}
                onColumnResize={onColumnResize}
                onCellEdited={onCellEdited}
                onHeaderClicked={handleHeaderClicked}
                customRenderers={customRenderers}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** See https://github.com/glideapps/glide-data-grid/blob/main/packages/core/API.md#htmlcss-prerequisites */
const useEnsurePortalElementForGDG = () =>
  React.useEffect(() => {
    const el = document.getElementById('portal')
    if (el !== null) return

    const portal = document.createElement('div')
    portal.id = 'portal'
    portal.style.position = 'fixed'
    portal.style.top = '0'
    portal.style.left = '0'
    portal.style.zIndex = '9999'

    document.body.append(portal)

    return () => {
      portal.remove()
    }
  })
