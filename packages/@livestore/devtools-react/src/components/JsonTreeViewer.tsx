import { Schema } from '@livestore/utils/effect'
import React from 'react'

import {
  createSchemaAwareNodeRenderer,
  ObjectInspector,
  ObjectLabel,
  ObjectName,
  ObjectPreview,
  ObjectRootLabel,
  ObjectValue,
  SchemaProvider,
  useSchemaContext,
} from '#vendor/react-inspector'

import { JsonTreeViewerContextMenu } from './JsonTreeViewerContextMenu.js'

/** Props for the Effect 4-aware DevTools JSON tree. */
export type JsonTreeViewerProps = {
  readonly data: unknown
  readonly schema?: Schema.Top
  readonly initiallyExpandedDepth?: number
  readonly hideRoot?: boolean
  readonly className?: string
  readonly arrayChunkSize?: number
}

/** Effect 4-aware object and array inspector used by DevTools. */
export const JsonTreeViewer: React.FC<JsonTreeViewerProps> = ({
  data,
  schema,
  initiallyExpandedDepth = 2,
  hideRoot = true,
  className,
  arrayChunkSize = 100,
}) => {
  const chunkedData = React.useMemo(
    () => chunkLargeArrays({ data, chunkSize: arrayChunkSize }),
    [data, arrayChunkSize],
  )
  const commonProps = {
    theme: pickInspectorTheme(),
    data: chunkedData,
    expandLevel: Math.max(0, initiallyExpandedDepth),
    name: hideRoot === true ? undefined : 'root',
    showNonenumerable: false,
    sortObjectKeys: true,
  }

  return (
    <div className={className} style={{ fontSize: 12, lineHeight: 1.4 }}>
      {schema === undefined ? (
        <ObjectInspector {...commonProps} nodeRenderer={renderDefaultNode} />
      ) : (
        <SchemaProvider schema={schema} rootData={data}>
          <ObjectInspector {...commonProps} nodeRenderer={renderSchemaNode} />
        </SchemaProvider>
      )}
    </div>
  )
}

type JsonTreeNodeRendererProps = {
  readonly depth: number
  readonly name: string | undefined
  readonly data: unknown
  readonly path: string
  readonly isNonenumerable: boolean | undefined
  readonly expanded: boolean | undefined
}

type SchemaView = Pick<Schema.Top, 'ast'>

const schemaAwareNodeRenderer = createSchemaAwareNodeRenderer({
  ObjectRootLabel,
  ObjectLabel,
  ObjectName,
  ObjectValue,
  ObjectPreview,
})

const renderDefaultNode = (props: JsonTreeNodeRendererProps) => <JsonTreeDefaultNode {...props} />
const renderSchemaNode = (props: JsonTreeNodeRendererProps) => <JsonTreeSchemaNode {...props} />

const JsonTreeDefaultNode: React.FC<JsonTreeNodeRendererProps> = ({
  depth,
  name,
  data,
  isNonenumerable,
}) => (
  <JsonTreeViewerContextMenu items={makeCopyItems({ value: data })} isDisabled={data === undefined}>
    {depth === 0 ? (
      <ObjectRootLabel name={name} data={data} />
    ) : (
      <ObjectLabel name={name} data={data} isNonenumerable={isNonenumerable} />
    )}
  </JsonTreeViewerContextMenu>
)

const JsonTreeSchemaNode: React.FC<JsonTreeNodeRendererProps> = (props) => {
  const schemaContext = useSchemaContext()
  const valueSchema = schemaContext.getSchemaForPath(props.path)
  return (
    <JsonTreeViewerContextMenu
      items={makeCopyItems({ value: props.data, schema: valueSchema })}
      isDisabled={props.data === undefined}
    >
      {schemaAwareNodeRenderer(props)}
    </JsonTreeViewerContextMenu>
  )
}

const makeCopyItems = ({ value, schema }: { value: unknown; schema?: SchemaView | undefined }) => [
  {
    id: 'copy-json',
    label: 'Copy JSON',
    onAction: () => {
      const json = encodeJsonForClipboard({ value, schema })
      if (json !== undefined) void navigator.clipboard.writeText(json)
    },
  },
]

const encodeJsonForClipboard = ({
  value,
  schema,
}: {
  value: unknown
  schema?: SchemaView | undefined
}): string | undefined => {
  if (value === undefined) return undefined
  try {
    const encoded =
      schema === undefined
        ? value
        : Schema.encodeUnknownSync(Schema.make<Schema.Codec<unknown, unknown>>(schema.ast))(value)
    return JSON.stringify(encoded, undefined, 2)
  } catch {
    try {
      return JSON.stringify(value, undefined, 2)
    } catch {
      return undefined
    }
  }
}

const pickInspectorTheme = (): 'chromeDark' | 'chromeLight' => {
  try {
    const colorScheme =
      getComputedStyle(document.documentElement).colorScheme ||
      document.documentElement.style.colorScheme
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    return colorScheme.trim() === 'dark' || prefersDark === true ? 'chromeDark' : 'chromeLight'
  } catch {
    return 'chromeLight'
  }
}

const chunkLargeArrays = ({ data, chunkSize }: { data: unknown; chunkSize: number }): unknown => {
  if (chunkSize <= 0) return data
  if (Array.isArray(data) === true) {
    if (data.length <= chunkSize)
      return data.map((item) => chunkLargeArrays({ data: item, chunkSize }))
    const chunks: Record<string, unknown[]> = {}
    for (let index = 0; index < data.length; index += chunkSize) {
      const end = Math.min(index + chunkSize - 1, data.length - 1)
      chunks[`[${index}..${end}]`] = data
        .slice(index, end + 1)
        .map((item) => chunkLargeArrays({ data: item, chunkSize }))
    }
    return chunks
  }
  if (data !== null && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        chunkLargeArrays({ data: value, chunkSize }),
      ]),
    )
  }
  return data
}
