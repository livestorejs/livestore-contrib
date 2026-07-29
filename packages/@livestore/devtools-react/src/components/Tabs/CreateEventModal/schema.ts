import { Result, Schema, SchemaAST, SchemaIssue } from '@livestore/utils/effect'

/**
 * Design notes:
 * - Keep encoded (input) and decoded (display) ASTs to respect Effect schema transforms.
 * - Choose render controls from the encoded shape, but use decoded annotations for user-facing hints (e.g. DateFromMillis -> datetime).
 * - Treat the schema as the source of truth: coerce UI values to decoded, then encode via schema to validate.
 * - Surface per-field errors by mapping ParseResult issues back to paths.
 */

export type FieldRenderKind = 'text' | 'number' | 'boolean' | 'datetime' | 'select' | 'textarea'

export type FieldOption = { label: string; value: string | number | boolean }

/** Structural description of a single field derived from the schema AST. */
export type FieldConfig = {
  path: ReadonlyArray<string>
  required: boolean
  encodedAst: SchemaAST.AST
  decodedAst: SchemaAST.AST
  render: FieldRenderKind
  options?: ReadonlyArray<FieldOption> | undefined
}

/** Format a Date/ISO string to the input-friendly yyyy-MM-ddTHH:mm shape. */
export const formatDateTimeInputValue = (value: unknown): string => {
  if (value instanceof Date && Number.isNaN(value.getTime()) === false)
    return value.toISOString().slice(0, 16)
  if (typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16)
  }
  return ''
}

export const buildFieldsFromAst = (
  ast: SchemaAST.AST,
  path: ReadonlyArray<string> = [],
  required = true,
): ReadonlyArray<FieldConfig> => {
  // Recurse into structs to keep precise paths; leaf nodes carry encoded/decoded AST for rendering + validation.
  if (SchemaAST.isObjects(ast)) {
    return ast.propertySignatures.flatMap((prop) =>
      buildFieldsFromAst(
        prop.type,
        [...path, String(prop.name)],
        required && SchemaAST.isOptional(prop.type) === false,
      ),
    )
  }

  const encodedAst = resolveEncodedAst(ast)
  const decodedAst = resolveDecodedAst(ast)
  const renderInfo = detectRenderConfig({ encodedAst, decodedAst })

  return [
    {
      path,
      required,
      encodedAst,
      decodedAst,
      render: renderInfo.kind,
      options: renderInfo.options ?? undefined,
    },
  ]
}

export const defaultValueForField = (field: FieldConfig): unknown => {
  if (field.render === 'select') return field.options?.[0]?.value ?? ''
  if (field.render === 'boolean') return false
  if (field.render === 'number') return ''
  if (field.render === 'datetime') return new Date()
  if (field.render === 'textarea') return ''
  return ''
}

export const isFieldValueMissing = (field: FieldConfig, value: unknown): boolean => {
  if (value === undefined) return true
  if (field.render === 'datetime') {
    if (value instanceof Date) return Number.isNaN(value.getTime())
    if (typeof value === 'string') return value.trim() === ''
    return true
  }
  if (field.render === 'number' || field.render === 'select' || field.render === 'textarea') {
    return value === ''
  }
  return false
}

export const coerceFieldValue = (field: FieldConfig, value: unknown): unknown => {
  if (value === undefined) return undefined

  switch (field.render) {
    case 'number': {
      if (value === '') return undefined
      if (typeof value === 'number') return Number.isNaN(value) ? undefined : value
      const parsed = Number(value)
      return Number.isNaN(parsed) ? undefined : parsed
    }
    case 'boolean':
      return Boolean(value)
    case 'datetime': {
      if (value === '') return undefined
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
      if (typeof value === 'string') {
        if (value.trim() === '') return undefined
        const asDate = new Date(value)
        return Number.isNaN(asDate.getTime()) ? undefined : asDate
      }
      return undefined
    }
    case 'textarea': {
      if (typeof value === 'string') {
        if (value.trim() === '') return undefined
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    }
    default:
      return value
  }
}

export const validateArgs = ({
  fields,
  argsState,
  eventSchema,
}: {
  fields: ReadonlyArray<FieldConfig>
  argsState: Record<string, unknown>
  eventSchema: Schema.Codec<unknown, unknown>
}): {
  ok: boolean
  missing: number
  decoded: Record<string, unknown> | undefined
  encoded: unknown
  fieldErrors: Record<string, ReadonlyArray<string>>
} => {
  // 1) Coerce UI values into decoded args. 2) Encode via schema to catch mismatches at the encoded boundary.
  let decodedArgs: Record<string, unknown> = {}
  let missingRequired = 0
  const fieldErrors: Record<string, ReadonlyArray<string>> = {}

  const appendFieldError = (path: ReadonlyArray<string>, message: string) => {
    const key = path.length === 0 ? '' : path.join('.')
    const existing = fieldErrors[key] ?? []
    fieldErrors[key] = existing.includes(message) ? existing : [...existing, message]
  }

  for (const field of fields) {
    const raw = getValueAtPath(argsState, field.path)
    const missing = field.required && isFieldValueMissing(field, raw)
    if (missing) {
      missingRequired += 1
      appendFieldError(field.path, 'Required')
      continue
    }
    const treatAsAbsent = isFieldValueMissing(field, raw)
    if (treatAsAbsent) continue
    const coerced = coerceFieldValue(field, raw)
    if (coerced === undefined) {
      const message =
        field.render === 'number'
          ? 'Must be a number'
          : field.render === 'datetime'
            ? 'Invalid date/time'
            : field.render === 'select'
              ? 'Select a valid option'
              : field.render === 'textarea'
                ? 'Invalid JSON'
                : 'Invalid value'
      appendFieldError(field.path, message)
      continue
    }
    decodedArgs = setValueAtPath(decodedArgs, field.path, coerced)
  }

  const encodeResult = Schema.encodeUnknownResult(eventSchema)(decodedArgs)

  if (
    Result.isSuccess(encodeResult) &&
    missingRequired === 0 &&
    Object.keys(fieldErrors).length === 0
  ) {
    return {
      ok: true,
      missing: 0,
      decoded: decodedArgs,
      encoded: encodeResult.success,
      fieldErrors,
    }
  }

  if (Result.isFailure(encodeResult)) {
    const { issues } = SchemaIssue.makeFormatterStandardSchemaV1()(encodeResult.failure.issue)
    for (const issue of issues ?? []) {
      const path = issue.path ?? []
      const key = path.length === 0 ? '' : path.map(String).join('.')
      fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message]
    }
  }

  return {
    ok: false,
    missing: missingRequired,
    decoded: undefined,
    encoded: undefined,
    fieldErrors,
  }
}

export const getValueAtPath = (obj: Record<string, unknown>, path: ReadonlyArray<string>) =>
  path.reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as any)[key] : undefined),
    obj,
  )

export const setValueAtPath = (
  obj: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): Record<string, unknown> => {
  if (path.length === 0) return obj
  const [head, ...rest] = path as [string, ...string[]]
  return {
    ...obj,
    [head]:
      rest.length === 0
        ? value
        : setValueAtPath((obj[head] as Record<string, unknown>) ?? {}, rest, value),
  }
}

const detectRenderConfig = ({
  encodedAst,
  decodedAst,
}: {
  encodedAst: SchemaAST.AST
  decodedAst: SchemaAST.AST
}): { kind: FieldRenderKind; options?: ReadonlyArray<FieldOption> } => {
  // Use encoded shape for control type; consult decoded annotations for user-facing hints (e.g. DateFromMillis -> datetime).
  const base = resolveEncodedAst(encodedAst)

  const decodedTypeConstructor = SchemaAST.resolve(resolveDecodedAst(decodedAst))?.typeConstructor
  const encodedIsNumber = SchemaAST.isNumber(base) || SchemaAST.isBigInt(base)
  const decodedIsDate =
    typeof decodedTypeConstructor === 'object' &&
    decodedTypeConstructor !== null &&
    '_tag' in decodedTypeConstructor &&
    decodedTypeConstructor._tag === 'Date'
  if (decodedIsDate && encodedIsNumber) {
    return { kind: 'datetime' }
  }

  const flattenUnionTypes = (node: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
    const resolved = resolveEncodedAst(node)
    if (SchemaAST.isUnion(resolved)) {
      return resolved.types.flatMap((t) => flattenUnionTypes(t))
    }
    return [resolved]
  }

  if (SchemaAST.isUnion(base)) {
    const members = flattenUnionTypes(base).filter(
      (node) => !SchemaAST.isUndefined(node) && !SchemaAST.isNull(node),
    )
    if (members.length === 1) {
      const single = members[0]!
      if (SchemaAST.isLiteral(single)) {
        return {
          kind: 'select',
          options: [{ label: String(single.literal), value: single.literal as any }],
        }
      }
      return detectRenderConfig({ encodedAst: single, decodedAst: single })
    }
    const allLiterals = members.every((m) => SchemaAST.isLiteral(m))
    if (allLiterals) {
      const options = members.map((m) => {
        const lit = m as SchemaAST.Literal
        return { label: String(lit.literal), value: lit.literal as any }
      })
      return { kind: 'select', options }
    }
    return { kind: 'textarea' }
  }

  if (SchemaAST.isArrays(base)) return { kind: 'textarea' }
  if (SchemaAST.isBoolean(base)) return { kind: 'boolean' }
  if (SchemaAST.isNumber(base) || SchemaAST.isBigInt(base)) return { kind: 'number' }
  if (SchemaAST.isLiteral(base))
    return {
      kind: 'select',
      options: [{ label: String(base.literal), value: base.literal as any }],
    }
  if (SchemaAST.isString(base)) return { kind: 'text' }
  return { kind: 'textarea' }
}

const resolveEncodedAst = (ast: SchemaAST.AST): SchemaAST.AST => SchemaAST.toEncoded(ast)

const resolveDecodedAst = (ast: SchemaAST.AST): SchemaAST.AST => SchemaAST.toType(ast)
