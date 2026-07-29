import * as GDG from '@glideapps/glide-data-grid'
import type * as GDGCells from '@glideapps/glide-data-grid-cells'
import { SchemaAST } from '@livestore/utils/effect'

import type { SessionIdCell } from './session-id-cell.js'
import type { DisplayColumn } from './useDisplayColumns.js'

export const VALUE_IS_NULL = Symbol('VALUE_IS_NULL')

/**
 * Utilities for resolving and formatting grid cells using schema information.
 */
type CellColors = {
  textNull: string
  textDark: string
}

export type ResolvedCell = {
  displayColumn: DisplayColumn | undefined
  cellData: unknown
  columnSchemaAst: SchemaAST.AST | undefined
}

type ResolveCellParams = {
  cell: GDG.Item
  displayColumns: ReadonlyArray<DisplayColumn>
  tableData: ReadonlyArray<any>
}

export const resolveCellData = ({
  cell,
  displayColumns,
  tableData,
}: ResolveCellParams): ResolvedCell => {
  const [col, row] = cell
  const dataRow = tableData[row]
  const displayColumn = displayColumns.at(col)

  if (displayColumn === undefined) {
    return {
      displayColumn,
      cellData: VALUE_IS_NULL,
      columnSchemaAst: undefined,
    }
  }

  if (dataRow === undefined) {
    console.error('dataRow is undefined', cell, tableData)
  }

  const cellData =
    displayColumn.kind === 'value-field'
      ? (dataRow?.value?.[displayColumn.fieldName] ?? VALUE_IS_NULL)
      : (dataRow?.[displayColumn.key] ?? VALUE_IS_NULL)

  const columnSchemaAst =
    displayColumn.kind === 'base' ? displayColumn.schemaAst : displayColumn.fieldAst

  return { displayColumn, cellData, columnSchemaAst }
}

export const formatCellData = (cellData: unknown): string => {
  if (cellData === VALUE_IS_NULL) return 'null'
  if (cellData instanceof Date) return cellData.toISOString()
  if (typeof cellData === 'string') return cellData
  if (typeof cellData === 'number') return cellData.toString()
  if (cellData instanceof Uint8Array) {
    return `blob(${cellData.length}): ${cellData.slice(0, 100).join(',').toString()}`
  }
  return JSON.stringify(cellData) ?? ''
}

export const buildGridCell = ({
  resolved,
  cellDataStr,
  hasDerivedMutations,
  cellColors,
  isSessionBoundTable,
  connectedSessionId,
}: {
  resolved: ResolvedCell
  cellDataStr: string
  hasDerivedMutations: boolean
  cellColors: CellColors
  isSessionBoundTable: boolean
  connectedSessionId: string
}): GDG.GridCell => {
  const { displayColumn, cellData, columnSchemaAst } = resolved

  if (!displayColumn) {
    return {
      kind: GDG.GridCellKind.Text,
      allowOverlay: false,
      readonly: true,
      displayData: '',
      data: '',
      copyData: '',
    }
  }

  if (isSessionBoundTable && displayColumn.kind === 'base' && displayColumn.key === 'id') {
    const sessionRow = typeof cellData === 'string' && cellData === connectedSessionId

    return {
      kind: GDG.GridCellKind.Custom,
      allowOverlay: false,
      readonly: true,
      data: {
        kind: 'session-id-cell',
        text: cellDataStr,
        isCurrentSession: sessionRow,
      },
      copyData: cellDataStr,
    } satisfies SessionIdCell
  }

  if (columnSchemaAst && SchemaAST.isBoolean(SchemaAST.toType(columnSchemaAst))) {
    const booleanValue =
      cellData === VALUE_IS_NULL || cellData === undefined
        ? null
        : typeof cellData === 'boolean'
          ? cellData
          : Boolean(cellData)

    return {
      kind: GDG.GridCellKind.Boolean,
      readonly: !hasDerivedMutations,
      allowOverlay: false,
      data: booleanValue,
      copyData: cellDataStr,
      themeOverride: {
        textDark: cellData === VALUE_IS_NULL ? cellColors.textNull : cellColors.textDark,
      },
    }
  }

  if (typeof cellData === 'number') {
    return {
      kind: GDG.GridCellKind.Number,
      allowOverlay: hasDerivedMutations,
      readonly: !hasDerivedMutations,
      displayData: cellDataStr,
      data: cellData,
      copyData: cellDataStr,
      themeOverride: {
        textDark: cellColors.textDark,
      },
    }
  }

  if (hasDerivedMutations && columnSchemaAst && SchemaAST.isUnion(columnSchemaAst)) {
    const allowedValues = columnSchemaAst.types.map((t) =>
      SchemaAST.isLiteral(t) && typeof t.literal === 'string'
        ? { label: t.literal, value: t.literal }
        : undefined,
    )
    if (allowedValues.every((_) => _ !== undefined)) {
      return {
        kind: GDG.GridCellKind.Custom,
        data: {
          kind: 'dropdown-cell',
          allowedValues,
          value: cellDataStr,
        },
        allowOverlay: true,
        copyData: cellDataStr,
      } satisfies GDGCells.DropdownCellType
    }
  }

  return {
    kind: GDG.GridCellKind.Text,
    allowOverlay: hasDerivedMutations,
    readonly:
      displayColumn.kind === 'base'
        ? displayColumn.tableColumn.type._tag === 'blob' ||
          displayColumn.tableColumn.primaryKey === true ||
          !hasDerivedMutations
        : !hasDerivedMutations,
    displayData: cellDataStr,
    data: cellDataStr,
    copyData: cellDataStr,
    themeOverride: {
      textDark: cellData === VALUE_IS_NULL ? cellColors.textNull : cellColors.textDark,
    },
  }
}

export const getSingleCellCopyValue = ({
  cell,
  displayColumns,
  tableData,
}: ResolveCellParams): string => {
  const { cellData, columnSchemaAst } = resolveCellData({ cell, displayColumns, tableData })

  if (cellData === VALUE_IS_NULL) return 'null'

  if (
    columnSchemaAst &&
    (SchemaAST.isString(SchemaAST.toType(columnSchemaAst)) ||
      (SchemaAST.isLiteral(columnSchemaAst) && typeof columnSchemaAst.literal === 'string'))
  ) {
    return typeof cellData === 'string' ? cellData : String(cellData ?? '')
  }

  if (cellData instanceof Date) return cellData.toISOString()
  if (typeof cellData === 'string') return cellData
  if (typeof cellData === 'number' || typeof cellData === 'boolean') return cellData.toString()
  if (cellData instanceof Uint8Array) {
    return `blob(${cellData.length}): ${cellData.slice(0, 100).join(',').toString()}`
  }

  return JSON.stringify(cellData) ?? ''
}
