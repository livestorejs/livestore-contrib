import Dagre from '@dagrejs/dagre'
import type * as LiveStore from '@livestore/livestore'
import { StoreInternalsSymbol } from '@livestore/livestore'
import type { ReactiveGraph } from '@livestore/livestore/internal'
import { Match, pipe, ReadonlyArray } from '@livestore/utils/effect'
import * as graphql from 'graphql'
import React from 'react'
// https://reactflow.dev/docs/quickstart/
import * as Reactflow from 'reactflow'

import { useDevtoolsStore } from '../../devtools-store-context.js'
import { useFormatSql } from '../../hooks/useFormatSql.js'
import { useTick } from '../../hooks/useTick.js'
import { cn } from '../../utils/cn.ts'
import { DevToolsButton } from '../DevToolsButton.js'

const time = {
  sec: 1_000,
  min: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

const intlDateTimeFormat = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'narrow',
  year: 'numeric',
})

const intlDateTimeFormatRelative = new Intl.RelativeTimeFormat('en', {
  numeric: 'auto',
  style: 'narrow',
})

const humanizedDate = ({ timestamp, nowMs }: { timestamp: number; nowMs: number }) => {
  const differenceMs = nowMs - timestamp
  const differenceMsAbs = Math.abs(differenceMs)

  if (differenceMsAbs < time.min) {
    return intlDateTimeFormatRelative.format(-Math.floor(differenceMs / time.sec), 'seconds')
  } else if (differenceMsAbs < time.hour) {
    return intlDateTimeFormatRelative.format(-Math.floor(differenceMs / time.min), 'minutes')
  } else if (differenceMsAbs < time.day) {
    return intlDateTimeFormatRelative.format(-Math.floor(differenceMs / time.hour), 'hours')
  } else if (differenceMsAbs < 30 * time.day) {
    return intlDateTimeFormatRelative.format(-Math.floor(differenceMs / time.day), 'days')
  } else {
    return intlDateTimeFormat.format(timestamp)
  }
}

type RefreshInfo = ReactiveGraph.RefreshDebugInfo<
  LiveStore.RefreshReason,
  LiveStore.QueryDebugInfo
> & {
  refreshedQueries: ReactiveGraph.AtomDebugInfo<LiveStore.QueryDebugInfo>[]
  humanizedTimestamp: string
  subLabel: string
}

export const Refreshes: React.FC = () => {
  const formatSql = useFormatSql()
  const [autoUpdate, setAutoUpdate] = React.useState(true)
  const _fastTick = useTick(500, autoUpdate)
  const _slowTick = useTick(10_000, true)
  const [selectedRefreshInfoId, setSelectedRefreshInfoId] = React.useState<string | undefined>(
    undefined,
  )

  const [subLabelFilter, setSubLabelFilter] = React.useState<string>('')
  const [showSkippedRefreshes, setShowSkippedRefreshes] = React.useState<boolean>(false)

  const store = useDevtoolsStore()

  const debugRefreshInfos = React.useMemo(
    () => store[StoreInternalsSymbol].reactivityGraph.debugRefreshInfos,
    [store[StoreInternalsSymbol].reactivityGraph],
  )

  const lastRefreshesSnapshot = React.useMemo(() => [...debugRefreshInfos], [debugRefreshInfos])

  const refreshes = React.useMemo(() => {
    try {
      const now = Date.now()

      return pipe(
        lastRefreshesSnapshot,
        ReadonlyArray.map(
          (refreshInfo): RefreshInfo => ({
            ...refreshInfo,
            refreshedQueries: refreshInfo.refreshedAtoms.filter(
              (atom) => atom.debugInfo._tag === 'graphql' || atom.debugInfo._tag === 'db',
            ),
            humanizedTimestamp: humanizedDate({
              timestamp: refreshInfo.completedTimestamp,
              nowMs: now,
            }),
            subLabel: pipe(
              Match.value(refreshInfo.reason),
              Match.tag('commit', (e) => e.events.map((e) => e.name).join(', ')),
              Match.tag('runDeferredEffects', () => 'manual refresh'),
              Match.tag('makeThunk', (e) => e.label ?? 'unknown thunk'),
              Match.tag(
                'react',
                (e) => `${e.label} ${e.stackInfo?.frames.map((_) => _.name).join('▸')}`,
              ),
              Match.tag('manual', (e) => e.label ?? 'unknown manual'),
              Match.tag('subscribe.initial', (e) => e.label ?? 'unknown subscribe.initial'),
              Match.tag('subscribe.update', (e) => e.label ?? 'unknown subscribe.update'),
              Match.tag('unknown', () => 'unknown'),
              Match.exhaustive,
            ),
          }),
        ),
        ReadonlyArray.filter((_) => _.subLabel.includes('__livestore_') === false),
        ReadonlyArray.filter((_) =>
          _.reason._tag === 'commit'
            ? _.reason.events.some(
                (_) => _.name === 'livestore.RawSql' && _.args.sql.includes('__livestore_'),
              ) === false
            : true,
        ),
        (_) =>
          subLabelFilter === ''
            ? _
            : _.filter((_) => _.subLabel.toLowerCase().includes(subLabelFilter.toLowerCase())),
        (_) => (showSkippedRefreshes ? _ : _.filter((_) => !_.skippedRefresh)),
        (_) => ReadonlyArray.reverse(_), // TODO use curried syntax when bug is fixed in Effect
        ReadonlyArray.take(100),
      )
    } catch (e) {
      console.warn(`Error in events tab: ${e}`)
      return [] as never
    }
  }, [lastRefreshesSnapshot, subLabelFilter, showSkippedRefreshes])

  const selectedRefreshInfo = React.useMemo(
    () =>
      selectedRefreshInfoId === undefined
        ? undefined
        : refreshes.find((_) => _.id === selectedRefreshInfoId),
    [refreshes, selectedRefreshInfoId],
  )

  return (
    <div className="divide-y divide-devtools-divider h-full flex flex-col">
      <div className="flex space-x-2 items-center p-1">
        <DevToolsButton size="xs" onClick={() => debugRefreshInfos.clear()}>
          Reset Refresh Log
        </DevToolsButton>
        <label className="flex items-center space-x-1">
          <input
            type="checkbox"
            className=""
            checked={autoUpdate}
            onChange={(e) => setAutoUpdate(e.target.checked)}
          />
          <span>Auto-update</span>
        </label>
        <input
          type="text"
          placeholder="Filter by event name"
          className="rounded-md px-1 py-px border border-devtools-border bg-devtools-surface text-devtools-text text-xs"
          value={subLabelFilter}
          onChange={(e) => setSubLabelFilter(e.target.value)}
        />
        <label className="flex items-center space-x-1">
          <input
            type="checkbox"
            className=""
            checked={showSkippedRefreshes}
            onChange={(e) => setShowSkippedRefreshes(e.target.checked)}
          />
          <span>Show Skipped Refreshes</span>
        </label>
      </div>
      <div className="flex space-x-2 flex-grow overflow-hidden">
        <div className="flex flex-col w-60 flex-shrink-0 flex-grow-0 h-full border-r border-devtools-divider">
          <div className="flex-grow h-full overflow-y-auto">
            {/* NOTE we're pausing auto-update to avoid jumping UI while the user is inspecting a given section */}
            {refreshes.map((refreshInfo) => (
              <RefreshListItem
                key={refreshInfo.id}
                refreshInfo={refreshInfo}
                isSelected={refreshInfo.id === selectedRefreshInfoId}
                onSelect={() => {
                  setAutoUpdate(false)
                  setSelectedRefreshInfoId(refreshInfo.id)
                }}
              />
            ))}
          </div>
          <div className="bg-devtools-background border-t border-devtools-divider px-2 py-1 text-xs">
            {refreshes.length} refreshes
          </div>
        </div>
        {selectedRefreshInfo !== undefined && (
          // NOTE key is used to reset viewport state of ReactFlow
          <RefreshView
            key={selectedRefreshInfoId}
            refreshInfo={selectedRefreshInfo}
            formatSql={formatSql}
          />
        )}
      </div>
    </div>
  )
}

const RefreshListItem: React.FC<{
  refreshInfo: RefreshInfo
  isSelected: boolean
  onSelect?: () => void
}> = ({ refreshInfo, isSelected, onSelect }) => {
  const label = React.useMemo(
    () =>
      pipe(
        Match.value(refreshInfo.reason),
        Match.tag('commit', () => `📝 Mutations`),
        Match.tag('runDeferredEffects', () => `🤜 Manual Refresh`),
        Match.tag('makeThunk', () => `🔎 Init query`),
        Match.tag('unknown', () => `❓ Unknown origin`),
        Match.tag('react', (_) => `⚛︎ React: ${_.api}`),
        Match.tag('manual', () => `Manual`),
        Match.tag('subscribe.initial', () => `🔄 Initial`),
        Match.tag('subscribe.update', () => `🔄 Update`),
        Match.exhaustive,
      ),
    [refreshInfo.reason],
  )

  return (
    <div
      role="application"
      onClick={onSelect}
      className={cn(
        'w-full space-y-2 p-2 overflow-hidden',
        isSelected ? 'bg-devtools-background-hover' : 'hover:bg-devtools-background-hover/50',
      )}
    >
      <div className="space-y-1">
        <div className="flex space-x-2">
          <div className="grow text-xs font-semibold overflow-hidden">{label}</div>
          <div className="shrink text-xs text-devtools-text-secondary">
            {refreshInfo.humanizedTimestamp}
          </div>
          <div className="shrink text-xs text-devtools-text-secondary">
            {refreshInfo.refreshedQueries.length} qs
          </div>
        </div>
        <div className="grow text-xs overflow-hidden">{refreshInfo.subLabel}</div>
      </div>

      <div className="w-full flex h-3 overflow-hidden rounded bg-devtools-surface border border-devtools-border text-[10px]">
        <div
          style={{ width: `${(refreshInfo.durationMs / 10) * 100}%` }}
          className="flex flex-col justify-center whitespace-nowrap bg-red-200 text-left"
        >
          {refreshInfo.durationMs.toFixed(2)}ms
        </div>
      </div>
    </div>
  )
}

type GraphNodeData = {
  label: string
  nodeWasRefreshed: boolean
  isWriteTable: boolean
  atom: ReactiveGraph.SerializedAtom
}

const RefreshView: React.FC<{
  refreshInfo: RefreshInfo
  formatSql: (s: string) => string
}> = ({ refreshInfo, formatSql }) => {
  const [showAll, setShowAll] = React.useState(false)

  const getAtomType = React.useCallback((atom: ReactiveGraph.SerializedAtom): string => {
    const meta = atom.meta
    if (typeof meta === 'object' && meta !== null) {
      if (
        atom._tag === 'ref' &&
        'liveStoreRefType' in meta &&
        typeof meta.liveStoreRefType === 'string'
      ) {
        return meta.liveStoreRefType
      }
      if (
        atom._tag === 'thunk' &&
        'liveStoreThunkType' in meta &&
        typeof meta.liveStoreThunkType === 'string'
      ) {
        return meta.liveStoreThunkType
      }
    }
    return 'default'
  }, [])

  const { nodes, edges } = React.useMemo(() => {
    const writeTables = refreshInfo.reason._tag === 'commit' ? refreshInfo.reason.writeTables : []
    const nodes = refreshInfo.graphSnapshot.atoms
      .map((atom) => {
        const nodeWasRefreshed = refreshInfo.refreshedAtoms.map((a) => a.atom.id).includes(atom.id)
        const refreshedStyle = {
          border: 'solid 2px red',
          background: '#ffc9c9',
          fontWeight: 'bold',
        }
        return {
          id: atom.id,
          position: { x: 0, y: 0 },
          type: getAtomType(atom),
          data: {
            label: atom.label ?? '',
            nodeWasRefreshed,
            atom,
            isWriteTable: writeTables.includes(atom.label ?? ''),
          },
          style:
            nodeWasRefreshed && showAll ? refreshedStyle : { background: 'white', fontWeight: 500 },
        }
      })
      .filter(
        (node) =>
          showAll ||
          node.data.nodeWasRefreshed ||
          node.data.atom.super.some((atomId) =>
            refreshInfo.refreshedAtoms.map((a) => a.atom.id).includes(atomId),
          ),
      )

    const edges = refreshInfo.graphSnapshot.atoms.flatMap((atom) =>
      atom.super.map((superComp) => ({
        id: `${atom.id}-${superComp}`,
        source: atom.id,
        target: superComp,
      })),
    )

    // TODO find a way to keep the graph layout stable while toggling the showAll checkbox
    const layouted = getLayoutedElements(nodes, edges)

    return layouted
  }, [
    refreshInfo.reason,
    refreshInfo.graphSnapshot.atoms,
    refreshInfo.refreshedAtoms,
    getAtomType,
    showAll,
  ])

  const nodeTypes = React.useMemo(
    () => ({
      table: TableNode,
      'db.query': SQLQueryNode,
      'db.result': SQLResultsNode,
      'graphql.variables': GraphQLVariablesNode,
      'graphql.result': GraphQLResultsNode,
      computed: JSResultsNode,
    }),
    [],
  )

  const horDivider = <div className="w-full h-px bg-devtools-border my-8" />

  return (
    <div className="flex space-x-2 h-full w-full overflow-hidden pt-2">
      <div className="basis-1/3 h-full overflow-auto space-y-2">
        <label className="flex items-center space-x-1">
          <input
            type="checkbox"
            className="form-checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          <div>Show all queries (including ones not updated in this refresh)</div>
        </label>
        {refreshInfo.reason._tag === 'commit' && (
          <>
            <div className="space-y-2">
              <div className="text-sm font-bold">Mutation Args</div>

              <pre className="w-full p-2 border border-devtools-border bg-devtools-surface rounded-md text-xs font-mono overflow-auto text-devtools-text">
                {JSON.stringify(
                  getFirstIfSingle(refreshInfo.reason.events.map((_) => _.args)),
                  null,
                  2,
                )}
              </pre>
            </div>
            {horDivider}
          </>
        )}
        {refreshInfo.reason._tag === 'commit' && (
          <>
            <div className="space-y-2">
              <div className="text-sm font-bold">Write tables</div>
              <pre className="font-mono text-xs">{refreshInfo.reason.writeTables.join(', ')}</pre>
            </div>
            {horDivider}
          </>
        )}
        {refreshInfo.skippedRefresh && refreshInfo.refreshedAtoms.length === 0 && (
          <div>🏎️ Skipped refresh</div>
        )}
        {refreshInfo.skippedRefresh && refreshInfo.refreshedAtoms.length > 0 && (
          <div>!? should never happen ‼️</div>
        )}
        {!refreshInfo.skippedRefresh && (
          <div>
            <div className="text-md">Reran {refreshInfo.refreshedQueries.length} queries:</div>
            {/* <div className="mb-2 text-neutral-400">
{!refreshInfo.skippedRefresh && refreshInfo.staleQueriesUpdated.length > 0 && (
  <div>
    ⚠️ Includes {refreshInfo.staleQueriesUpdated.length} stale queries from previous skipped
    refreshes: {refreshInfo.staleQueriesUpdated.join(', ')}
  </div>
)}
</div> */}
            <div className="space-y-1 py-4">
              {refreshInfo.refreshedQueries.map((atomDebugInfo, index) => (
                //  wrap the pre above in a div with a max height and scroll overflow
                <div key={index}>
                  <div className="text-sm text-devtools-text-secondary">
                    {atomDebugInfo.debugInfo._tag}
                  </div>
                  <div className="relative w-64 pt-1">
                    <div className="mb-4 flex h-4 overflow-hidden rounded bg-devtools-surface border border-devtools-border text-xs">
                      <div
                        style={{ width: `${(atomDebugInfo.debugInfo.durationMs / 10) * 100}%` }}
                        className="flex flex-col justify-center whitespace-nowrap bg-red-800 text-left text-white shadow-none"
                      >
                        {atomDebugInfo.debugInfo.durationMs.toFixed(2)}ms
                      </div>
                    </div>
                  </div>
                  <div className="max-h-48 w-full overflow-y-scroll border border-neutral-800 rounded-md p-2 text-xs font-mono">
                    <pre key={index}>
                      {atomDebugInfo.debugInfo._tag === 'db'
                        ? formatSql(atomDebugInfo.debugInfo.query ?? '').trim()
                        : atomDebugInfo.debugInfo._tag === 'graphql'
                          ? graphql.print(graphql.parse(atomDebugInfo.debugInfo.query))
                          : JSON.stringify(atomDebugInfo.debugInfo.query)}
                    </pre>
                  </div>
                  <div className="w-1/3 h-px bg-devtools-border my-6 mx-auto" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="basis-2/3 bg-devtools-background-secondary/30">
        <Reactflow.ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={{ animated: true }}
          minZoom={0.1}
          // TODO re-run `fitView` when the graph changes
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Reactflow.MiniMap
            maskColor="rgb(50, 50, 50, 0.8)"
            maskStrokeColor="white"
            nodeColor={(node) =>
              node.data.nodeWasRefreshed && showAll ? 'red' : 'rgb(0, 0, 0, 0.8)'
            }
            nodeStrokeWidth={3}
            style={{ height: 150, width: 300 }}
            zoomable
            pannable
          />
        </Reactflow.ReactFlow>
      </div>
    </div>
  )
}

const getLayoutedElements = (nodes: Reactflow.Node<GraphNodeData>[], edges: Reactflow.Edge[]) => {
  // NOTE this can happen when an action doesn't result in any query re-runs (e.g. during app bootup)
  // We return early here since `Dagre.layout` crashes when there are no nodes
  if (nodes.length === 0) return { nodes: [], edges: [] }

  // TODO re-write this using `graphology` some day when we've found an equivalent layout algorithm
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))

  g.setGraph({ nodesep: 50, ranksep: 300 })

  const nodeIds = new Set(nodes.map((node) => node.id))

  // biome-ignore lint/suspicious/useIterableCallbackReturn: mutating graph structure without using return value
  nodes.forEach((node) =>
    g.setNode(node.id, { width: node.data.label.length * 13 + 30, height: 40 }),
  )
  edges
    // TODO do this filtering earlier
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    // biome-ignore lint/suspicious/useIterableCallbackReturn: mutating graph structure without using return value
    .forEach((edge) => g.setEdge(edge.source, edge.target))

  Dagre.layout(g)

  return {
    nodes: nodes.map((node) => {
      const { x, y } = g.node(node.id)

      return { ...node, position: { x, y } }
    }),
    edges,
  }
}

const TableNode = ({ data }: Reactflow.NodeProps<GraphNodeData>) => {
  return (
    <>
      <div className={cn('p-4 text-black', data.isWriteTable ? 'bg-red-200' : '')}>
        <div className="mb-2 text-xs text-devtools-text-secondary">
          <span className="mr-2">💾</span>Table
        </div>
        <h1 className="font-mono">{data.label}</h1>
      </div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Bottom} id="a" />
    </>
  )
}

const SQLQueryNode = ({ data }: Reactflow.NodeProps) => {
  return (
    <>
      <div className="p-4 text-black">
        <div className="mb-2 text-xs text-devtools-text-secondary">
          <span className="mr-2">🔎</span>SQL Query String
        </div>
        <h1 className="font-mono">{data.label}</h1>
      </div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Bottom} id="a" />
    </>
  )
}

const SQLResultsNode = ({ data }: Reactflow.NodeProps) => {
  return (
    <>
      <div className="p-4 text-black">
        <div className="mb-2 text-xs text-devtools-text-secondary">
          <span className="mr-2">🔎</span>SQL Results
        </div>
        <h1 className="font-mono">{data.label}</h1>
      </div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Bottom} id="a" />
    </>
  )
}

// make node types for graphql variable values, results, and js results

const GraphQLResultsNode = ({ data }: Reactflow.NodeProps) => {
  return (
    <>
      <Reactflow.Handle type="target" position={Reactflow.Position.Top} />
      <div className="p-4 text-black">
        <div className="mb-2 text-xs text-devtools-text-secondary">
          <span className="mr-2">🔎</span>GraphQL Results
        </div>
        <h1 className="font-mono">{data.label}</h1>
      </div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Bottom} id="a" />
    </>
  )
}

const GraphQLVariablesNode = ({ data }: Reactflow.NodeProps) => {
  return (
    <>
      <Reactflow.Handle type="target" position={Reactflow.Position.Top} />
      <div className="p-4 text-black">
        <div className="mb-2 text-xs text-devtools-text-secondary">
          <span className="mr-2">🔎</span>GraphQL Variables
        </div>
        <h1 className="font-mono">{data.label}</h1>
      </div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Bottom} id="a" />
    </>
  )
}

const JSResultsNode = ({ data }: Reactflow.NodeProps) => {
  return (
    <>
      <Reactflow.Handle type="target" position={Reactflow.Position.Top} />
      <div className="p-4 text-black">
        <div className="mb-2 text-xs text-devtools-text-secondary">
          <span className="mr-2">🔎</span>JS Results
        </div>
        <h1 className="font-mono">{data.label}</h1>
      </div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Bottom} id="a" />
    </>
  )
}

const getFirstIfSingle = <T,>(arr: ReadonlyArray<T>): T | ReadonlyArray<T> =>
  arr.length === 1 ? arr[0]! : arr
