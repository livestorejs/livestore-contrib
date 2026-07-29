import type * as GDG from '@glideapps/glide-data-grid'
import * as LiveStore from '@livestore/livestore'
import { Schema, SchemaAST } from '@livestore/utils/effect'
import React from 'react'

import { sessionIdBadgeExtraWidth } from './session-id-cell.js'

export type DisplayColumn =
  | {
      kind: 'base'
      key: string
      header: string
      tableColumn: LiveStore.SqliteAst.Column
      schemaAst: SchemaAST.AST
    }
  | {
      kind: 'value-field'
      key: string
      header: string
      fieldName: string
      fieldAst: SchemaAST.AST
    }

export type UseDisplayColumnsResult = {
  displayColumns: ReadonlyArray<DisplayColumn>
  gridColumns: ReadonlyArray<GDG.GridColumn>
  defaultColumnWidths: Record<string, number>
  effectiveOrderByColumn: string
}

export const useDisplayColumns = ({
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
  // orderByDirection,
}: {
  currentTableDef: LiveStore.State.SQLite.TableDef | undefined
  tableColumns: Record<string, LiveStore.SqliteAst.Column>
  columnKeys: string[]
  tableData: ReadonlyArray<any>
  columnWidths: Record<string, number>
  dataGridTheme: Partial<GDG.Theme>
  isSessionBoundTable: boolean
  hasDerivedMutations: boolean
  defaultColumnName: string
  orderByColumn: string
  orderByDirection: string
}): UseDisplayColumnsResult => {
  const valueFieldColumns = React.useMemo<ReadonlyArray<DisplayColumn>>(() => {
    if (
      !hasDerivedMutations ||
      currentTableDef === undefined ||
      LiveStore.State.SQLite.tableIsClientDocumentTable(currentTableDef) === false
    )
      return []

    const valueAst = currentTableDef.valueSchema.ast

    if (SchemaAST.isObjects(valueAst) === false) {
      return []
    }

    const props = valueAst.propertySignatures

    return props.map(
      (prop): DisplayColumn => ({
        kind: 'value-field',
        key: `value.${String(prop.name)}`,
        header: `value.${String(prop.name)}`,
        fieldName: String(prop.name),
        fieldAst: prop.type,
      }),
    )
  }, [currentTableDef, hasDerivedMutations])

  const displayColumns = React.useMemo<ReadonlyArray<DisplayColumn>>(() => {
    const shouldFlattenValue = valueFieldColumns.length > 0

    const baseColumns: DisplayColumn[] = columnKeys.flatMap((colName) => {
      if (shouldFlattenValue && colName === 'value') {
        return []
      }

      const tableColumn = tableColumns[colName]
      if (!tableColumn) return []

      return [
        {
          kind: 'base',
          key: colName,
          header: colName,
          tableColumn,
          schemaAst: Schema.toType(tableColumn.schema).ast,
        } satisfies DisplayColumn,
      ]
    })

    return [...baseColumns, ...valueFieldColumns]
  }, [columnKeys, tableColumns, valueFieldColumns])

  const effectiveOrderByColumn = tableColumns[orderByColumn] ? orderByColumn : defaultColumnName

  const defaultColumnWidths: Record<string, number> = {}
  for (const displayColumn of displayColumns) {
    if (columnWidths[displayColumn.key] !== undefined) continue

    const badgeExtra =
      displayColumn.kind === 'base' && isSessionBoundTable && displayColumn.key === 'id'
        ? sessionIdBadgeExtraWidth(dataGridTheme)
        : 0

    if (displayColumn.kind === 'base') {
      defaultColumnWidths[displayColumn.key] = getDefaultColumnWidth(
        displayColumn.tableColumn,
        tableData,
        badgeExtra,
      )
    } else {
      defaultColumnWidths[displayColumn.key] = getDefaultValueFieldWidth(
        displayColumn.fieldName,
        tableData,
        badgeExtra,
      )
    }
  }

  const gridColumns = React.useMemo(
    () =>
      displayColumns.map(
        (col): GDG.GridColumn => ({
          title: col.header,
          id: col.key,
          width: columnWidths[col.key] ?? defaultColumnWidths[col.key] ?? 200,
        }),
      ),
    [displayColumns, columnWidths, defaultColumnWidths],
  )

  return { displayColumns, gridColumns, defaultColumnWidths, effectiveOrderByColumn }
}

const getDefaultColumnWidth = (
  colDef: LiveStore.SqliteAst.Column,
  tableData: ReadonlyArray<any>,
  extraWidth = 0,
) => {
  if (tableData.length === 0) return 200 + extraWidth

  if (colDef.type._tag === 'text' || colDef.type._tag === 'integer') {
    const charLengths = tableData
      // Only look at the first 100 rows
      .slice(0, 100)
      .map<number>((row) => row?.[colDef.name]?.toString().length ?? 0)
      .sort((a, b) => a - b)

    const charLengthLimit = 150
    const p80CharLength = charLengths[Math.floor(charLengths.length * 0.8)] ?? 0
    const charScaleFactor = 8.4
    const extraSpacing = 20

    return (
      Math.min(Math.max(p80CharLength * charScaleFactor, 100), charLengthLimit * charScaleFactor) +
      extraSpacing +
      extraWidth
    )
  }

  return 200 + extraWidth
}

const getDefaultValueFieldWidth = (
  fieldName: string,
  tableData: ReadonlyArray<any>,
  extraWidth = 0,
) => {
  if (tableData.length === 0) return 200 + extraWidth

  const charLengths = tableData
    // Only look at the first 100 rows
    .slice(0, 100)
    .map<number>((row) => row?.value?.[fieldName]?.toString().length ?? 0)
    .sort((a, b) => a - b)

  const charLengthLimit = 150
  const p80CharLength = charLengths[Math.floor(charLengths.length * 0.8)] ?? 0
  const charScaleFactor = 8.4
  const extraSpacing = 20

  return (
    Math.min(Math.max(p80CharLength * charScaleFactor, 100), charLengthLimit * charScaleFactor) +
    extraSpacing +
    extraWidth
  )
}
