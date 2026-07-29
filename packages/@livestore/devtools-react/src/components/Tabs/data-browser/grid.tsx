import * as GDG from '@glideapps/glide-data-grid'
import * as GDGCells from '@glideapps/glide-data-grid-cells'
import React from 'react'

import {
  buildGridCell,
  formatCellData,
  getSingleCellCopyValue,
  resolveCellData,
} from './cell-format.js'
import type { DisplayColumn } from './useDisplayColumns.js'
import { useSingleCellCopy } from './useSingleCellCopy.js'

type CellColors = {
  textNull: string
  textDark: string
}

type DataBrowserGridProps = {
  displayColumns: ReadonlyArray<DisplayColumn>
  gridColumns: ReadonlyArray<GDG.GridColumn>
  tableData: ReadonlyArray<any>
  cellColors: CellColors
  hasDerivedMutations: boolean
  isSessionBoundTable: boolean
  connectedSessionId: string
  dataGridTheme: Partial<GDG.Theme>
  onColumnResize: (column: GDG.GridColumn, newSize: number) => void
  onCellEdited: (cell: GDG.Item, newValue: GDG.EditableGridCell) => void
  onHeaderClicked: (colIndex: number) => void
  customRenderers?: ReadonlyArray<GDG.CustomRenderer>
  maxColumnWidth?: number
  width?: number | string
  height?: number | string
  rowHeight?: number
  headerHeight?: number
}

/**
 * Thin wrapper around GDG's DataEditor that wires in schema-aware formatting and single-cell copy.
 */
export const DataBrowserGrid: React.FC<DataBrowserGridProps> = ({
  displayColumns,
  gridColumns,
  tableData,
  cellColors,
  hasDerivedMutations,
  isSessionBoundTable,
  connectedSessionId,
  dataGridTheme,
  onColumnResize,
  onCellEdited,
  onHeaderClicked,
  customRenderers,
  maxColumnWidth = 1000,
  width = '100%',
  height = '100%',
  rowHeight = 22,
  headerHeight = 26,
}) => {
  const dataEditorContainerRef = React.useRef<HTMLDivElement | null>(null)

  const getCellContent = React.useCallback(
    (cell: GDG.Item): GDG.GridCell => {
      const resolved = resolveCellData({ cell, displayColumns, tableData })
      const cellDataStr = formatCellData(resolved.cellData)

      return buildGridCell({
        resolved,
        cellDataStr,
        hasDerivedMutations,
        cellColors,
        isSessionBoundTable,
        connectedSessionId,
      })
    },
    [
      cellColors,
      connectedSessionId,
      displayColumns,
      hasDerivedMutations,
      isSessionBoundTable,
      tableData,
    ],
  )

  const getCopyValue = React.useCallback(
    (cell: GDG.Item) =>
      getSingleCellCopyValue({
        cell,
        displayColumns,
        tableData,
      }),
    [displayColumns, tableData],
  )

  const { gridSelection, setGridSelection } = useSingleCellCopy({
    dataEditorContainerRef,
    getCopyValue,
  })

  const selectionProps =
    gridSelection === undefined
      ? {}
      : ({
          gridSelection,
        } satisfies { gridSelection: GDG.GridSelection })

  return (
    <div ref={dataEditorContainerRef} className="h-full">
      <GDG.DataEditor
        {...{
          customRenderers: customRenderers ?? [GDGCells.DropdownCell],
          getCellContent,
          columns: gridColumns,
          rows: tableData.length,
          smoothScrollX: true,
          smoothScrollY: true,
          onColumnResize,
          onCellEdited,
          getCellsForSelection: true,
          onHeaderClicked,
          onGridSelectionChange: setGridSelection,
          ...selectionProps,
          maxColumnWidth,
          width,
          height,
          rowHeight,
          headerHeight,
          theme: dataGridTheme,
        }}
      />
    </div>
  )
}
