import Dagre from '@dagrejs/dagre'
import * as GDG from '@glideapps/glide-data-grid'
import { StoreInternalsSymbol } from '@livestore/livestore'
import type { ReactiveGraph } from '@livestore/livestore/internal'
import type { StateSetters } from '@livestore/react'
import { shouldNeverHappen } from '@livestore/utils'
import { Effect, Hash, pipe, ReadonlyArray, Schema, Stream } from '@livestore/utils/effect'
import React from 'react'
import * as RAC from 'react-aria-components'
// https://reactflow.dev/docs/quickstart/
import * as Reactflow from 'reactflow'

import { useDevtoolsStore } from '../../../devtools-store-context.js'
import { useSessionContext } from '../../../session-context.js'
import { useTheme } from '../../../theme/mod.js'
import { cn } from '../../../utils/cn.ts'
import { getThemeAwareCellColors, useDataGridTheme } from '../../DataGridTheme.js'
import { DevToolsButton } from '../../DevToolsButton.js'
import { JsonTreeViewer } from '../../JsonTreeViewer.js'
import type { Row } from './DagNodes-common.js'
import { NOT_REFRESHED_YET, stateSchemaAtomsTab } from './DagNodes-common.js'

export type State = typeof stateSchemaAtomsTab.Value
export type SetState = StateSetters<typeof stateSchemaAtomsTab>

export type SerializedNode = ReactiveGraph.SerializedAtom | ReactiveGraph.SerializedEffect

export const DagNodes: React.FC = () => {
  const store = useDevtoolsStore()

  // TODO bring back "pausing reactivity" functionality
  const [_nodesChanged, forceNodesChanged] = React.useState([])

  const [state, setState] = store.useClientDocument(stateSchemaAtomsTab)

  const isMountedRef = React.useRef(false)

  React.useEffect(() => {
    isMountedRef.current = true

    let forceNodesChangedTimeout: any

    const unsub = store[StoreInternalsSymbol].reactivityGraph.subscribeToRefresh(() => {
      forceNodesChangedTimeout = setTimeout(() => {
        if (isMountedRef.current) {
          forceNodesChanged([])
        }
      }, 0)
    })

    return () => {
      isMountedRef.current = false
      clearTimeout(forceNodesChangedTimeout)
      unsub()
    }
  }, [store])

  const [snapshot, setSnapshot] = React.useState<ReactiveGraph.ReactiveGraphSnapshot | undefined>(
    undefined,
  )
  const snapshotHashRef = React.useRef(0)

  const { apiSession } = useSessionContext()

  React.useEffect(
    () =>
      apiSession.signalSnapshots().pipe(
        Stream.tapSync((newSnapshot) => {
          const newSnapshotHash = Hash.hash(JSON.stringify(newSnapshot))
          if (newSnapshotHash !== snapshotHashRef.current) {
            setSnapshot(newSnapshot)
            snapshotHashRef.current = newSnapshotHash
          }
        }),
        Stream.runDrain,
        Effect.tapCauseLogPretty,
        Effect.runCallback,
      ),
    [apiSession],
  )

  const nodes = React.useMemo(
    () => (snapshot ? [...snapshot.atoms, ...snapshot.effects] : []),
    [snapshot],
  )

  // const nodes = React.useMemo(() => {
  //   const snapshot = store.graph.getSnapshot({ includeResults: true })
  //   return [...nodesChanged, ...snapshot.atoms, ...snapshot.effects]
  // }, [store.graph, nodesChanged])

  return <DagNodesPure nodes={nodes} snapshot={snapshot} state={state} setState={setState} />
}

export const DagNodesPaste: React.FC<{
  state: State
  setState: SetState
}> = ({ state, setState }) => {
  const [snapshot, setSnapshot] = React.useState<ReactiveGraph.ReactiveGraphSnapshot | undefined>(
    undefined,
  )

  React.useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text')

      const parsedData = (() => {
        if (!text) return null
        try {
          return JSON.parse(text)
        } catch (e) {
          console.error('Failed to parse clipboard data. Trying to eval', e)
          try {
            // biome-ignore lint/security/noGlobalEval: It's ok here
            return eval(`(${text})`)
          } catch (e) {
            console.error('Failed to parse clipboard data', e)
          }

          return null
        }
      })()

      if (parsedData) {
        setSnapshot(parsedData)
      }
    }

    document.addEventListener('paste', handler)

    return () => document.removeEventListener('paste', handler)
  })

  const nodes = React.useMemo(
    () => (snapshot ? [...snapshot.atoms, ...snapshot.effects] : []),
    [snapshot],
  )

  return <DagNodesPure nodes={nodes} snapshot={snapshot} state={state} setState={setState} />
}

export const DagNodesPure: React.FC<{
  nodes: ReadonlyArray<SerializedNode>
  snapshot: ReactiveGraph.ReactiveGraphSnapshot | undefined
  state: State
  setState: SetState
}> = ({
  nodes: allNodes,
  snapshot,
  state: { columnWidths, sortColumn, showMap, hideEffects, minUpdates },
  setState,
}) => {
  const lastUpdatedCache = React.useMemo(() => new LastUpdatedCache(), [])
  const dataGridTheme = useDataGridTheme()
  const { isDark } = useTheme()
  const _cellColors = React.useMemo(() => getThemeAwareCellColors(isDark), [isDark])

  /** Maps from a node id to a boolean whether to show the nodes super nodes in the list */
  const [showSuperValuesRef, getShowSuper, setShowSuper, resetShowSuper, replaceShowSuper] =
    useMapRef(new Map<string, boolean>())

  // Initialize the showSuper map when nodes change
  if (showSuperValuesRef.current.size !== allNodes.length) {
    showSuperValuesRef.current = new Map(allNodes.map((node) => [node.id, true]))
  }

  const transitiveShowSuperLookupMap = React.useMemo(() => {
    const transitiveMap = new Map<string, boolean>()
    const sortedNodes = topologicalSort(allNodes)
    for (const node of sortedNodes) {
      const showNode =
        getShowSuper(node.id) === true &&
        (node.sub.length > 0 ? node.sub.some((sub) => transitiveMap.get(sub) === true) : true)

      transitiveMap.set(node.id, showNode)
    }
    return transitiveMap
  }, [getShowSuper, allNodes])

  const filteredNodes = React.useMemo(
    () =>
      pipe(
        allNodes,
        ReadonlyArray.sort(compareNodeById),
        ReadonlyArray.filter((node) => transitiveShowSuperLookupMap.get(node.id) === true),
        (_) => (hideEffects ? ReadonlyArray.filter(_, (_) => _._tag !== 'effect') : _),
        (_) =>
          minUpdates > 0 ? ReadonlyArray.filter(_, (_) => getNodeUpdates(_) >= minUpdates) : _,
      ),

    [hideEffects, minUpdates, allNodes, transitiveShowSuperLookupMap],
  )

  const compareNodes = React.useCallback(
    (a: Row, b: Row) => {
      const mult = sortColumn.direction === 'asc' ? 1 : -1
      if (sortColumn.column === 'id') {
        return compareNodeById(a, b) * mult
      } else {
        const aVal = a[sortColumn.column]
        const bVal = b[sortColumn.column]

        if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * mult

        return (aVal?.toString() ?? '').localeCompare(bVal?.toString() ?? '') * mult
      }
    },
    [sortColumn],
  )

  const onColumnResize = React.useCallback(
    (column: GDG.GridColumn, newSize: number) =>
      setState(({ columnWidths }) => ({
        columnWidths: { ...columnWidths, [column.id as any]: newSize },
      })),
    [setState],
  )

  const columns = React.useMemo(
    () =>
      [
        { id: 'index', title: '#', width: columnWidths.index },
        { id: 'showSuper', title: 'showSuper', width: columnWidths.showSuper },
        { id: 'id', title: 'id', width: columnWidths.id },
        { id: '_tag', title: 'tag', width: columnWidths._tag },
        { id: 'label', title: 'label', width: columnWidths.label },
        {
          id: 'previousResult',
          title: 'previousResult',
          width: columnWidths.previousResult,
        },
        { id: 'updates', title: 'updates', width: columnWidths.updates },
        { id: 'sub', title: 'sub', width: columnWidths.sub },
        { id: 'super', title: 'super', width: columnWidths.super },
        { id: 'meta', title: 'meta', width: columnWidths.meta },
      ] satisfies GDG.GridColumn[],
    [columnWidths],
  )

  const columnKeys = React.useMemo(() => columns.map((_) => _.id), [columns]) as (keyof Row)[]

  const tableData = React.useMemo(
    () =>
      filteredNodes
        .map(
          (node, index) =>
            ({
              index: index + 1,
              showSuper: getShowSuper(node.id) ?? shouldNeverHappen(),
              _tag: node._tag,
              id: node.id,
              label: node.label ?? '',
              previousResult:
                node._tag === 'effect'
                  ? ''
                  : node.previousResult._tag === 'Some'
                    ? node.previousResult.value === '"SYMBOL_NOT_REFRESHED_YET"'
                      ? NOT_REFRESHED_YET
                      : (node.previousResult.value ?? '')
                    : '-',
              updates: getNodeUpdates(node),
              sub: node.sub.join(', '),
              super: node._tag === 'effect' ? '' : node.super.join(', '),
              meta: node._tag === 'effect' ? '' : JSON.stringify(node.meta),
            }) satisfies Row,
        )
        .sort(compareNodes),
    [compareNodes, filteredNodes, getShowSuper],
  )

  const getCellContent = React.useCallback(
    (cell: GDG.Item): GDG.GridCell => {
      const [col, row] = cell
      const dataRow = tableData[row]
      const columnKey = columnKeys[col]!

      const cellData = dataRow?.[columnKey]
      const cellDataStr =
        cellData === NOT_REFRESHED_YET ? '' : (cellData?.toString().slice(0, 5000) ?? '')

      if (columnKey === 'showSuper') {
        return {
          kind: GDG.GridCellKind.Boolean,
          data: cellData as boolean,
          allowOverlay: false,
        } satisfies GDG.BooleanCell
      }

      const lu = lastUpdatedCache.getLastUpdated(col, row, cellDataStr)
      return {
        kind: GDG.GridCellKind.Text,
        readonly: true,
        displayData: cellDataStr,
        data: cellDataStr,
        allowOverlay: true,
        ...(lu !== undefined ? { lastUpdated: lu } : {}),
      }
    },
    [columnKeys, tableData, lastUpdatedCache],
  )

  const showOnlyRelatedNodes = React.useCallback(
    (nodeId: string) => {
      const targetNode = allNodes.find((_) => _.id === nodeId)!

      const newShowSuperValues = new Map(allNodes.map((_) => [_.id, false]))

      newShowSuperValues.set(nodeId, true)

      // traverse super nodes and set them to true recursively
      const superNodeIds = targetNode._tag === 'effect' ? [] : [...targetNode.super]
      while (superNodeIds.length > 0) {
        const superNodeId = superNodeIds.pop()!
        newShowSuperValues.set(superNodeId, true)
        const superNode = allNodes.find((_) => _.id === superNodeId)!
        if (superNode._tag !== 'effect') superNodeIds.push(...superNode.super)
      }

      // traverse sub nodes and set them to true recursively
      const subNodeIds = [...targetNode.sub]
      while (subNodeIds.length > 0) {
        const subNodeId = subNodeIds.pop()!
        newShowSuperValues.set(subNodeId, true)
        const subNode = allNodes.find((_) => _.id === subNodeId)!
        subNodeIds.push(...subNode.sub)
      }

      replaceShowSuper(newShowSuperValues)
    },
    [replaceShowSuper, allNodes],
  )

  const { apiSession } = useSessionContext()

  const copySnapshotToClipboard = React.useCallback(() => {
    apiSession
      .copyToClipboard(JSON.stringify(snapshot, null, 2))
      .pipe(Effect.tapCauseLogPretty, Effect.runPromise)
  }, [snapshot, apiSession])

  return (
    <div className="space-y-1 h-full flex flex-col">
      <div className="flex space-x-2 items-center text-xs p-2">
        <span className="font-semibold text-devtools-text">{filteredNodes.length} nodes</span>
        <div className="flex items-center">
          <RAC.ToggleButton
            isSelected={!showMap}
            onChange={() => setState({ showMap: false })}
            className={cn(
              'px-2 py-1 text-xs rounded-l border border-r-0 transition-all',
              !showMap
                ? 'bg-devtools-border text-devtools-text border-devtools-border shadow-sm'
                : 'bg-devtools-surface text-devtools-text-secondary border-devtools-border hover:bg-devtools-border hover:text-devtools-text',
            )}
          >
            Table
          </RAC.ToggleButton>
          <RAC.ToggleButton
            isSelected={showMap}
            onChange={() => setState({ showMap: true })}
            className={cn(
              'px-2 py-1 text-xs rounded-r border transition-all',
              showMap
                ? 'bg-devtools-border text-devtools-text border-devtools-border shadow-sm'
                : 'bg-devtools-surface text-devtools-text-secondary border-devtools-border hover:bg-devtools-border hover:text-devtools-text',
            )}
          >
            Map
          </RAC.ToggleButton>
        </div>
        <label className="flex items-center space-x-1 text-devtools-text">
          <input
            type="checkbox"
            className="text-devtools-focus"
            checked={hideEffects}
            onChange={(e) => setState({ hideEffects: e.target.checked })}
          />
          <span>Hide Effects</span>
        </label>
        <label className="flex items-center space-x-1 text-devtools-text">
          <input
            type="number"
            className="w-8 bg-devtools-surface text-devtools-text border border-devtools-border rounded px-1"
            value={minUpdates}
            step={1}
            min={0}
            onChange={(e) => setState({ minUpdates: Number.parseInt(e.target.value, 10) })}
          />
          <span>Minimum updates</span>
        </label>
        <DevToolsButton size="xs" onClick={resetShowSuper}>
          Reset showSuper
        </DevToolsButton>
        <DevToolsButton size="xs" onClick={copySnapshotToClipboard}>
          Copy Snapshot to Clipboard
        </DevToolsButton>
      </div>
      {showMap ? (
        <FlowMap
          nodes={filteredNodes}
          showOnlyRelatedNodes={showOnlyRelatedNodes}
          isDark={isDark}
        />
      ) : (
        <GDG.DataEditor
          {...{
            getCellContent,
            columns,
            rows: tableData.length,
            smoothScrollX: true,
            smoothScrollY: true,
            onColumnResize,
            getCellsForSelection: true,
            onCellClicked: ([col, row], event) => {
              if (event.shiftKey) {
                const columnKey = columnKeys[col]!
                if (columnKey === 'showSuper') {
                  showOnlyRelatedNodes(tableData[row]!.id)
                  event.preventDefault()
                }
              }
            },
            onCellEdited: ([col, row], value) => {
              const dataRow = tableData[row] ?? shouldNeverHappen()
              const columnKey = columnKeys[col]!
              if (columnKey === 'showSuper') {
                setShowSuper(dataRow.id, value.data as boolean)
              }
            },
            onHeaderClicked: (col) => {
              const column = columns[col]!.id as keyof Row
              setState((prev) => ({
                sortColumn: {
                  column,
                  direction:
                    prev.sortColumn.column === column && prev.sortColumn.direction === 'asc'
                      ? 'desc'
                      : 'asc',
                },
              }))
            },
            width: '100%',
            height: '100%',
            rowHeight: 20,
            headerHeight: 28,
            theme: {
              ...dataGridTheme,
              headerFontStyle: 'bold 11px',
              baseFontStyle: '11px',
            },
          }}
        />
      )}
    </div>
  )
}

const compareNodeById = (a: { id: string }, b: { id: string }) => {
  const aNum = Number.parseInt(a.id.replace('node-', ''), 10)
  const bNum = Number.parseInt(b.id.replace('node-', ''), 10)
  if (aNum === bNum) return 0
  return aNum < bNum ? -1 : 1
}

const FlowMap: React.FC<{
  nodes: ReadonlyArray<SerializedNode>
  showOnlyRelatedNodes: (nodeId: string) => void
  isDark: boolean
}> = ({ nodes: nodes_, showOnlyRelatedNodes, isDark }) => {
  const { nodes, edges } = React.useMemo(() => {
    // const writeTables =
    //   refreshInfo.reason._tag === 'commit'
    //     ? refreshInfo.reason.writeTables
    //     : []
    const nodes = nodes_.map((node) => {
      // const nodeWasRefreshed = refreshInfo.refreshedAtoms.map((a) => a.node.id).includes(node.id)
      const nodeWasRefreshed = false
      const refreshedStyle = {
        border: 'solid 2px red',
        background: '#ffc9c9',
        fontWeight: 'bold',
      }

      return {
        id: node.id,
        position: { x: 0, y: 0 },
        // type: getAtomType(node),
        type: 'default',
        data: { node, showOnlyRelatedNodes, isDark },
        // style: nodeWasRefreshed && showAll ? refreshedStyle : { background: 'white', fontWeight: 500 },
        style: nodeWasRefreshed
          ? refreshedStyle
          : {
              background: isDark ? '#2a2a2a' : 'white',
              fontWeight: 500,
              width: (node.label?.length ?? 0) * 7 + 10,
            },
      }
    })

    const edges = nodes_
      .filter((_): _ is ReactiveGraph.SerializedAtom => _._tag !== 'effect')
      .flatMap((atom) =>
        atom.super.map((superCompId) => ({
          id: `${atom.id}-${superCompId}`,
          source: atom.id,
          target: superCompId,
        })),
      )

    // TODO find a way to keep the graph layout stable while toggling the showAll checkbox
    const layouted = getLayoutedElements(nodes, edges)

    return layouted
  }, [nodes_, showOnlyRelatedNodes, isDark])

  const nodeTypes = React.useMemo(
    () => ({
      default: DefaultNode,
      // table: TableNode,
      // dbQuery: SQLQueryStringNode,
      // dbResults: SQLResultsNode,
      // graphqlResults: GraphQLResultsNode,
      // graphqlQuery: GraphQLVariablesNode,
      // computed: JSResultsNode,
    }),
    [],
  )

  return (
    <div className="w-full h-full">
      <Reactflow.ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={{ animated: true }}
        minZoom={0.1}
        // TODO re-run `fitView` when the graph changes
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: isDark ? '#1a1a1a' : '#eee' }}
      >
        <Reactflow.MiniMap
          maskColor={isDark ? 'rgb(20, 20, 20, 0.8)' : 'rgb(50, 50, 50, 0.8)'}
          maskStrokeColor={isDark ? '#555' : 'white'}
          nodeColor={(node) =>
            node.data.nodeWasRefreshed
              ? 'red'
              : isDark
                ? 'rgb(255, 255, 255, 0.8)'
                : 'rgb(0, 0, 0, 0.8)'
          }
          nodeStrokeWidth={3}
          style={{ height: 150, width: 300 }}
          zoomable
          pannable
        />
      </Reactflow.ReactFlow>
    </div>
  )
}

const getNodeUpdates = (node: SerializedNode) =>
  node._tag === 'thunk'
    ? node.recomputations
    : node._tag === 'effect'
      ? node.invocations
      : node.refreshes

const getLayoutedElements = (nodes: Reactflow.Node<RFNode>[], edges: Reactflow.Edge[]) => {
  // Seems like Dagre is failing when there are no nodes, so we're returning early
  if (nodes.length === 0) return { nodes: [], edges: [] }

  // TODO re-write this using `graphology` some day when we've found an equivalent layout algorithm
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))

  g.setGraph({ nodesep: 50, ranksep: 300 })

  const horPadding = 16 * 2 + 10 * 2
  // biome-ignore lint/suspicious/useIterableCallbackReturn: mutating graph structure without using return value
  nodes.forEach((node) =>
    // NOTE `width` and `height` are not used by `react-flow` but are used by `dagre`
    g.setNode(node.id, {
      width: (node.data.node.label?.length ?? 10) * 13 + horPadding,
      height: 40,
    }),
  )

  // biome-ignore lint/suspicious/useIterableCallbackReturn: mutating graph structure without using return value
  edges.forEach((edge) => g.setEdge(edge.source, edge.target))

  Dagre.layout(g)

  return {
    nodes: nodes.map((node) => {
      const { x, y } = g.node(node.id)

      return { ...node, position: { x, y }, className: '!w-fit' }
    }),
    edges,
  }
}

const useMapRef = <K, V>(initialMap: Map<K, V>) => {
  const ref = React.useRef(initialMap)
  const [_updateVal, triggerUpdate] = React.useReducer((n) => n + 1, 0)
  const set = React.useCallback((key: K, value: V) => {
    ref.current.set(key, value)
    triggerUpdate()
  }, [])

  const get = React.useCallback((key: K) => ref.current.get(key), [])

  const reset = React.useCallback(() => {
    ref.current = initialMap
    triggerUpdate()
  }, [initialMap])

  const replace = React.useCallback((newMap: Map<K, V>) => {
    ref.current = newMap
    triggerUpdate()
  }, [])

  return [ref, get, set, reset, replace] as const
}

type RFNode = {
  node: SerializedNode
  showOnlyRelatedNodes: (nodeId: string) => void
  isDark: boolean
}

const DefaultNode = ({
  data: { node, showOnlyRelatedNodes, isDark },
}: Reactflow.NodeProps<RFNode>) => {
  const [expandState, setExpandState] = React.useState<'expanded' | 'collapsed' | 'hover'>(
    'collapsed',
  )

  return (
    <>
      <Reactflow.Handle type="target" position={Reactflow.Position.Top} />
      <div
        role="application"
        className={cn(
          'p-4 text-devtools-text',
          node._tag !== 'effect' && node.super.length === 0 ? 'text-devtools-text-secondary' : '',
        )}
        onClick={(e) => {
          if (e.shiftKey) {
            showOnlyRelatedNodes(node.id)
          } else {
            setExpandState((_) => (_ === 'expanded' ? 'collapsed' : 'expanded'))
          }
        }}
        onMouseEnter={() => expandState === 'collapsed' && setExpandState('hover')}
        onMouseLeave={() => expandState === 'hover' && setExpandState('collapsed')}
      >
        <div className="mb-2 text-xs text-devtools-text-secondary flex space-x-2">
          <span>{node.id.replace('node-', '#')}</span>
          <span>{getNodeUpdates(node)} updates</span>
          <span>{node.sub.length} ↑</span>
          <span>{node._tag === 'effect' ? 0 : node.super.length} ↓</span>
        </div>
        <h1 className="font-mono">{node.label}</h1>
        {expandState !== 'collapsed' && node._tag !== 'effect' && (
          <div
            className={cn(
              'text-left nowheel mt-3 text-xs font-mono p-2 rounded-md max-h-[200px] overflow-auto max-w-[400px]',
              isDark ? 'bg-black/30' : 'bg-black/5',
            )}
          >
            <JsonTreeViewer
              data={formatForViewer(
                parseMaybeJson(
                  node.previousResult._tag === 'Some' ? node.previousResult.value : undefined,
                ),
              )}
              schema={Schema.Json}
              initiallyExpandedDepth={1}
              hideRoot={true}
            />
          </div>
        )}
      </div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Bottom} id="a" />
    </>
  )
}

const CHUNK_SIZE = 100

const parseMaybeJson = (v: unknown): unknown => {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  return v
}

const formatForViewer = (value: unknown): unknown => {
  if (Array.isArray(value) && value.length > CHUNK_SIZE) {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, value.length)
      out[`${i}…${end - 1} (${end - i})`] = value.slice(i, end)
    }
    return out
  }
  return value
}

class LastUpdatedCache {
  private valueMap = new Map<string, any>()
  private lastUpdatedMap = new Map<string, number>()

  // eslint-disable-next-line prefer-arrow/prefer-arrow-functions
  getLastUpdated(col: number, row: number, value: any): number | undefined {
    const key = `${col}:${row}`
    const oldValue = this.valueMap.get(key)
    if (oldValue !== value) {
      this.valueMap.set(key, value)
      const lastUpdated = performance.now()

      // This excludes the first update, which is usually the initial value
      if (lastUpdated < 1000) return undefined

      this.lastUpdatedMap.set(key, lastUpdated)
      return lastUpdated
    }

    return this.lastUpdatedMap.get(key)
  }
}

const topologicalSort = (nodes: ReadonlyArray<SerializedNode>): ReadonlyArray<SerializedNode> => {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))

  const sortedNodes: SerializedNode[] = []

  const visited = new Set<string>()

  const visit = (node: SerializedNode) => {
    if (visited.has(node.id)) return
    visited.add(node.id)

    for (const subId of node.sub) {
      const sub = nodeMap.get(subId)
      if (sub) visit(sub)
    }

    sortedNodes.push(node)
  }

  for (const node of nodes) {
    visit(node)
  }

  return sortedNodes
}
