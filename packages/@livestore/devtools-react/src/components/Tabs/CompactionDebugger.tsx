import 'reactflow/dist/style.css'
import Dagre from '@dagrejs/dagre'
import type { EventDefFacts, EventDefFactsSnapshot } from '@livestore/common/schema'
import { EventSequenceNumber } from '@livestore/common/schema'
import type { ConnectionType, HistoryDag, HistoryDagNode } from '@livestore/common/sync/next'
import {
  compactEvents,
  connectionTypeOptions,
  EMPTY_FACT_VALUE,
  factsSnapshotForDag,
} from '@livestore/common/sync/next'
import React from 'react'
import * as ReactFlow from 'reactflow'

import { cn } from '../../utils/cn.ts'

const edgeStateOptions = ['active', 'invisible', 'omitted'] as const
type EdgeState = (typeof edgeStateOptions)[number]

type EdgeStateRecord = Record<ConnectionType, EdgeState>

const EdgeStateRecordContext = React.createContext<EdgeStateRecord>({
  parent: 'active',
  facts: 'active',
})

export const CompactionDebugger: React.FC<{ dag: HistoryDag }> = ({ dag }) => {
  const [showCompacted, setShowCompacted] = usePersistedState('showCompacted', false)
  // TODO use LiveStore
  const [edgeStates, setEdgeStates] = usePersistedState<EdgeStateRecord>('edgeStates', {
    parent: 'active',
    facts: 'active',
  })

  return (
    <div className="w-full h-full relative">
      <div className="absolute top-0 p-2 rounded-md left-0 bg-black flex gap-2 z-40 opacity-40 hover:opacity-100 transition-opacity duration-300">
        {connectionTypeOptions.map((connectionType) => (
          <div key={connectionType} className="flex flex-col gap-1">
            <div className="text-white text-xs flex gap-1 items-center">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: connectionType === 'parent' ? '#fff' : '#d130d1' }}
              />
              <span>{connectionType}</span>
            </div>
            <div className="flex gap-1">
              {edgeStateOptions.map((edgeState) => (
                <button
                  type="button"
                  key={edgeState}
                  onClick={() =>
                    setEdgeStates((prev) => ({ ...prev, [connectionType]: edgeState }))
                  }
                  className={`px-1 py-0.5 rounded-sm text-xs ${
                    edgeStates[connectionType] === edgeState
                      ? 'bg-white text-black'
                      : 'bg-gray-900 text-white'
                  }`}
                >
                  {edgeState}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setShowCompacted(!showCompacted)}
          className={`px-1 py-0.5 rounded-sm text-xs ${
            showCompacted ? 'bg-white text-black' : 'bg-gray-900 text-white'
          }`}
        >
          Compact
        </button>
      </div>
      <EdgeStateRecordContext.Provider value={edgeStates}>
        <div className="w-full h-full flex gap-1">
          <DagGraph dag={dag} />
          {showCompacted && <DagGraph dag={compactEvents(dag).dag} />}
        </div>
      </EdgeStateRecordContext.Provider>
    </div>
  )
}

export const DagGraph: React.FC<{ dag: HistoryDag }> = ({ dag }) => {
  const edgeStates = React.useContext(EdgeStateRecordContext)
  const [nodes, setNodes] = React.useState<ReactFlow.Node[]>([])
  const [edges, setEdges] = React.useState<ReactFlow.Edge[]>([])
  React.useEffect(() => {
    const { nodes, edges } = layoutGraph(dag, edgeStates)

    setNodes(nodes)
    setEdges(edges)
  }, [dag, edgeStates])

  const onNodesChange = React.useCallback(
    (changes: ReactFlow.NodeChange[]) =>
      setNodes((nds) => ReactFlow.applyNodeChanges(changes, nds)),
    [],
  )

  return (
    <ReactFlow.ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      fitView
      nodeTypes={nodeTypes}
      proOptions={{ hideAttribution: true }}
    >
      <ReactFlow.Background />
      <div className="absolute bottom-0 right-0 text-white text-xs opacity-20">
        {nodes.length} events
      </div>
    </ReactFlow.ReactFlow>
  )
}

const layoutGraph = (dag: HistoryDag, edgeStates: EdgeStateRecord) => {
  const dagNodes = Array.from(dag.nodeEntries()).map((_) => _.attributes)
  const factSnapshotMap = new Map<string, EventDefFactsSnapshot>()
  for (let i = 0; i < dagNodes.length; i++) {
    const facts = factsSnapshotForDag(dag, dagNodes[i]?.seqNum)
    factSnapshotMap.set(EventSequenceNumber.Client.toString(dagNodes[i]!.seqNum), facts)
  }

  const nodes: ReactFlow.Node[] = dagNodes.map((event) => ({
    id: EventSequenceNumber.Client.toString(event.seqNum),
    data: {
      event,
      factsSnapshot: factSnapshotMap.get(EventSequenceNumber.Client.toString(event.seqNum)),
    },
    position: { x: 0, y: 0 }, // Initially set position as dagre will update it shortly
    type: 'custom',
  }))

  // Gather all outbound edges for all nodes (no direct all-edges iterator)
  const allEdges = Array.from(dag.nodes()).flatMap((id) => dag.outboundEdgeEntries(id))
  // Deduplicate via edge index to avoid duplicates when traversing
  const edgeNodes = Array.from(new Map(allEdges.map((e) => [e.edge, e])).values())

  const edges: ReactFlow.Edge[] = [
    ...(edgeStates.parent === 'omitted'
      ? []
      : // Parent -> Child connections
        edgeNodes
          .filter((_) => _.attributes.type === 'parent')
          .map((edge) => {
            const color = edgeStates.parent === 'active' ? '#fff' : '#fff0'

            return {
              id: String(edge.edge),
              source: edge.source,
              target: edge.target,
              sourceHandle: 'parent-source',
              targetHandle: 'parent-target',
              style: { stroke: color },
              markerStart: { type: ReactFlow.MarkerType.Arrow, color },
            }
          })),
    // Dependency connections
    ...(edgeStates.facts === 'omitted'
      ? []
      : edgeNodes
          .filter((_) => _.attributes.type === 'facts')
          .map((edge) => {
            const color = edgeStates.facts === 'active' ? '#d130d1' : '#fff0'
            return {
              id: String(edge.edge),
              source: edge.source,
              target: edge.target,
              sourceHandle: 'impacted-by-source',
              targetHandle: 'impacted-by-target',
              style: { stroke: color },
              markerStart: { type: ReactFlow.MarkerType.Arrow, color },
            } satisfies ReactFlow.Edge
          })),
  ]

  // Create a new dagre graph
  const dagreGraph = new Dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  // Set graph options
  const DEFAULT_NODE_WIDTH = 200
  const DEFAULT_NODE_HEIGHT = 60
  dagreGraph.setGraph({ rankdir: 'TB', nodesep: 70, ranksep: 70 })

  // Add nodes to the dagre graph
  nodes.forEach((node) => {
    const nodeWidth =
      node.id === EventSequenceNumber.Client.toString(EventSequenceNumber.Client.ROOT)
        ? 20
        : DEFAULT_NODE_WIDTH
    const nodeHeight =
      node.id === EventSequenceNumber.Client.toString(EventSequenceNumber.Client.ROOT)
        ? 20
        : DEFAULT_NODE_HEIGHT
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  })

  // Add edges to the dagre graph
  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })

  // Use dagre to calculate node positions
  Dagre.layout(dagreGraph)

  // Update node positions based on dagre layout
  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    const nodeWidth =
      node.id === EventSequenceNumber.Client.toString(EventSequenceNumber.Client.ROOT)
        ? 20
        : DEFAULT_NODE_WIDTH
    const nodeHeight =
      node.id === EventSequenceNumber.Client.toString(EventSequenceNumber.Client.ROOT)
        ? 20
        : DEFAULT_NODE_HEIGHT
    node.position = {
      x: nodeWithPosition.x - nodeWidth / 2,
      y: nodeWithPosition.y - nodeHeight / 2,
    }
  })

  return { nodes, edges }
}

const offset = 20
const offsetNudgeRight = `calc(50% + ${offset}px)`
const offsetNudgeLeft = `calc(50% - ${offset}px)`

const CustomNode: React.FC<
  ReactFlow.NodeProps<{ event: HistoryDagNode; factsSnapshot: EventDefFactsSnapshot }>
> = ({ data: { event, factsSnapshot } }) => {
  const [isLabelExanded, setIsLabelExanded] = React.useState(false)
  const dataLabel = React.useMemo(() => {
    if (Object.keys(event.args).length === 0) {
      return event.name
    }

    const label = isLabelExanded
      ? Object.entries(event.args)
          .map(([key, value]) => `${key}:${value}`)
          .join(', ')
      : Object.values(event.args).join(', ')

    return `${event.name}(${label})`
  }, [event.args, event.name, isLabelExanded])

  const edgeStates = React.useContext(EdgeStateRecordContext)

  const sourceHandles = (
    <>
      <ReactFlow.Handle
        type="source"
        position={ReactFlow.Position.Bottom}
        id="parent-source"
        className="bg-transparent opacity-0"
        style={{
          left: event.seqNum === EventSequenceNumber.Client.ROOT ? undefined : offsetNudgeRight,
          bottom: -2,
        }}
      />
      <ReactFlow.Handle
        type="source"
        position={ReactFlow.Position.Bottom}
        id="impacted-by-source"
        className="bg-transparent opacity-0"
        style={{
          left: event.seqNum === EventSequenceNumber.Client.ROOT ? undefined : offsetNudgeLeft,
          bottom: -2,
        }}
      />
    </>
  )

  if (event.seqNum === EventSequenceNumber.Client.ROOT) {
    return (
      <div
        className={cn('w-4 h-4 rounded-full bg-white', event.meta?.className)}
        style={event.meta?.style}
      >
        {sourceHandles}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'p-2 bg-white rounded-md max-w-[200px] max-h-[80px] overflow-hidden hover:overflow-visible hover:max-h-fit',
        event.seqNum.client === 0 ? 'bg-white' : 'bg-gray-300',
        event.meta?.className,
      )}
      style={event.meta?.style}
    >
      <div
        role="application"
        className={cn('w-full flex gap-1 items-center', {
          'text-ellipsis overflow-hidden whitespace-nowrap': !isLabelExanded,
        })}
        onClick={() => setIsLabelExanded(!isLabelExanded)}
      >
        <span className="text-[8px] font-semibold leading-none text-white rounded-full px-0.5 py-px bg-black">
          {EventSequenceNumber.Client.toString(event.seqNum)}
        </span>
        <span className="text-[10px] text-black">{dataLabel}</span>
      </div>

      {edgeStates.facts !== 'omitted' && (
        <div className="leading-[10px] text-[8px] flex flex-wrap gap-0.5 mt-1">
          {[
            ...factsToStringArray(event.factsGroup.depRequire).map((_) => `↖${_}`),
            ...factsToStringArray(event.factsGroup.depRead).map((_) => `↖?${_}`),
          ].map((_) => (
            <span key={_} className="text-purple-600 dark:text-purple-400 whitespace-nowrap">
              {_}
            </span>
          ))}
          {factsToStringArray(event.factsGroup.modifySet).map((_) => (
            <span key={_} className="text-green-600 dark:text-green-400 whitespace-nowrap">
              +{_}
            </span>
          ))}
          {factsToStringArray(event.factsGroup.modifyUnset).map((_) => (
            <span key={_} className="text-red-600 dark:text-red-400 whitespace-nowrap">
              -{_}
            </span>
          ))}
        </div>
      )}

      {edgeStates.facts !== 'omitted' && isLabelExanded && factsSnapshot.size > 0 && (
        <div className="text-[8px] text-gray-700">
          Facts: {factsToStringArray(factsSnapshot).join(', ')}
        </div>
      )}

      <ReactFlow.Handle
        type="target"
        position={ReactFlow.Position.Top}
        id="parent-target"
        className="bg-transparent opacity-0"
        style={{ left: offsetNudgeRight, top: 6 }}
      />
      <ReactFlow.Handle
        type="target"
        position={ReactFlow.Position.Top}
        id="impacted-by-target"
        className="bg-transparent opacity-0"
        style={{ left: offsetNudgeLeft, top: 6 }}
      />
      {sourceHandles}
    </div>
  )
}

const factsToStringArray = (facts: EventDefFacts) => {
  return Array.from(facts.entries()).map(
    ([key, value]) => key + (value === EMPTY_FACT_VALUE ? '' : `(${value})`),
  )
}

const nodeTypes: ReactFlow.NodeTypes = {
  custom: CustomNode,
}

const usePersistedState = <T,>(storageKey: string, initialValue: T) => {
  const [state, setState] = React.useState<T>(() => {
    const persistedValue = localStorage.getItem(storageKey)
    return persistedValue ? JSON.parse(persistedValue) : initialValue
  })

  React.useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(state))
  }, [storageKey, state])

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === storageKey && event.newValue !== null) {
        const newState = JSON.parse(event.newValue)
        setState((prevState) => (prevState === newState ? prevState : newState))
      }
    }

    window.addEventListener('storage', handleStorageChange)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
    }
  }, [storageKey])

  return [state, setState] as const
}
