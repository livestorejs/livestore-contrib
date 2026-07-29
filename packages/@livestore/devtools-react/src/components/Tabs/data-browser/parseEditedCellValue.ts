import type * as GDG from '@glideapps/glide-data-grid'
import { SchemaAST } from '@livestore/utils/effect'

export const nullSentinel = '__NULL__'

/**
 * Coerces edited grid cell data into a schema-compatible value so mutations keep table types intact.
 */
export const parseEditedCellValue = ({
  cell,
  columnSchemaAst,
  existingValue,
}: {
  cell: GDG.EditableGridCell
  columnSchemaAst: SchemaAST.AST
  existingValue: unknown
}) => {
  const rawData = (cell as { data?: unknown }).data

  if (rawData === nullSentinel) return null
  if (isDropdownData(rawData)) return rawData.value
  if (typeof rawData === 'number') return rawData

  const expectedPrimitive = inferPrimitiveTypeFromSchemaAst(columnSchemaAst)

  if (expectedPrimitive === 'number') {
    const parsed = Number.parseFloat(String(rawData))
    return Number.isNaN(parsed)
      ? typeof existingValue === 'number'
        ? existingValue
        : rawData
      : parsed
  }

  if (expectedPrimitive === 'boolean') {
    const parsed = normalizeBoolean(rawData)
    return parsed ?? (typeof existingValue === 'boolean' ? existingValue : Boolean(rawData))
  }

  return rawData
}

type PrimitiveKind = 'boolean' | 'number'

function isDropdownData(data: unknown): data is { kind: 'dropdown-cell'; value: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'dropdown-cell'
  )
}

function normalizeBoolean(data: unknown): boolean | undefined {
  if (typeof data === 'boolean') return data
  if (typeof data === 'number') return data !== 0

  const normalized = String(data).trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  if (normalized === '1') return true
  if (normalized === '0') return false

  return undefined
}

function inferPrimitiveTypeFromSchemaAst(ast: SchemaAST.AST): PrimitiveKind | undefined {
  const decodedAst = SchemaAST.toType(ast)

  if (SchemaAST.isBoolean(decodedAst)) {
    return 'boolean'
  }

  if (SchemaAST.isNumber(decodedAst)) {
    return 'number'
  }

  if (SchemaAST.isLiteral(decodedAst)) {
    const literalType = typeof decodedAst.literal
    if (literalType === 'boolean' || literalType === 'number') {
      return literalType
    }
  }

  if (SchemaAST.isUnion(decodedAst)) {
    const primitiveTypes = new Set(
      decodedAst.types
        .filter((type) => SchemaAST.isUndefined(type) === false && SchemaAST.isNull(type) === false)
        .map((type) => inferPrimitiveTypeFromSchemaAst(type))
        .filter((type): type is PrimitiveKind => type !== undefined),
    )

    if (primitiveTypes.size === 1) {
      return primitiveTypes.values().next().value
    }

    return undefined
  }

  if (SchemaAST.isSuspend(decodedAst)) {
    return inferPrimitiveTypeFromSchemaAst(decodedAst.thunk())
  }

  return undefined
}
