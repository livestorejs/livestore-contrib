import { Devtools } from '@livestore/common'
import * as LiveStore from '@livestore/livestore'
import { EventSequenceNumber } from '@livestore/livestore'
import { Duration, Effect, Schema, Stream } from '@livestore/utils/effect'
import React from 'react'
import * as Reactflow from 'reactflow'

import { useDevtoolsStore } from '../../devtools-store-context.js'
import { useTick } from '../../hooks/useTick.js'
import { useSessionContext } from '../../session-context.js'
import { cn } from '../../utils/utils.js'
import { useClientSessions } from '../ClientSessionList.js'
import { DevToolsButton } from '../DevToolsButton.js'
import { Icons } from '../Icons/mod.js'

const bootedMs = Date.now()

const ConnectionStatusDetails: React.FC<{
  networkStatusArr: readonly Devtools.NetworkStatus[]
  now: number
  inline?: boolean
}> = ({ networkStatusArr, now, inline = false }) => {
  const currentStatus = networkStatusArr.at(-1)
  const lastDisconnection = React.useMemo(() => {
    // Find the most recent disconnection event
    for (let i = networkStatusArr.length - 1; i >= 0; i--) {
      const status = networkStatusArr[i]
      if (!status?.isConnected && !status?.devtools.latchClosed) {
        return status
      }
    }
    return undefined
  }, [networkStatusArr])

  const lastConnection = React.useMemo(() => {
    // Find the most recent connection event
    for (let i = networkStatusArr.length - 1; i >= 0; i--) {
      const status = networkStatusArr[i]
      if (status?.isConnected && !status?.devtools.latchClosed) {
        return status
      }
    }
    return undefined
  }, [networkStatusArr])

  const formatTimeAgo = (timestampMs: number) => {
    const diffMs = now - timestampMs
    const diffSec = Math.floor(diffMs / 1000)
    const diffMin = Math.floor(diffSec / 60)
    const diffHour = Math.floor(diffMin / 60)

    if (diffHour > 0) return `${diffHour}h ago`
    if (diffMin > 0) return `${diffMin}m ago`
    if (diffSec > 0) return `${diffSec}s ago`
    return 'just now'
  }

  if (inline) {
    // Show only the most relevant status info in inline mode
    if (currentStatus?.isConnected && lastConnection) {
      return (
        <span className="text-xs text-devtools-text-secondary">
          • {formatTimeAgo(lastConnection.timestampMs)}
        </span>
      )
    }
    if (!currentStatus?.isConnected && !currentStatus?.devtools.latchClosed && lastDisconnection) {
      return (
        <span className="text-xs text-devtools-text-secondary">
          • {formatTimeAgo(lastDisconnection.timestampMs)}
        </span>
      )
    }
    return null
  }

  return (
    <div className="text-xs text-devtools-text-secondary space-y-1">
      <div className="flex flex-col sm:flex-row sm:items-center sm:space-x-4 space-y-1 sm:space-y-0">
        {currentStatus?.isConnected && lastConnection && (
          <span>Connected • {formatTimeAgo(lastConnection.timestampMs)}</span>
        )}
        {currentStatus?.devtools.latchClosed && <span>Sync paused</span>}
        {!currentStatus?.isConnected &&
          !currentStatus?.devtools.latchClosed &&
          lastDisconnection && (
            <span>Disconnected • {formatTimeAgo(lastDisconnection.timestampMs)}</span>
          )}
        {lastDisconnection && currentStatus?.isConnected && (
          <span>Last disconnection: {formatTimeAgo(lastDisconnection.timestampMs)}</span>
        )}
      </div>
    </div>
  )
}

const networkStatus$ = LiveStore.queryDb({
  query: LiveStore.sql`
  SELECT json_extract(value, '$.status') as status FROM __livestore_devtools_NetworkState
  WHERE json_extract(value, '$.status.timestampMs') > ${bootedMs - Duration.minutes(5).pipe(Duration.toMillis)}
  ORDER BY id ASC
`,
  schema: Schema.Struct({ status: Schema.fromJsonString(Devtools.NetworkStatus) }).pipe(
    Schema.pluck('status'),
    Schema.Array,
  ),
})

export const Sync: React.FC = () => {
  const store = useDevtoolsStore()
  const networkStatusArr = store.useQuery(networkStatus$)
  const [syncingInfo, setSyncingInfo] = React.useState<
    typeof Devtools.Leader.SyncingInfo.Type | undefined
  >(undefined)
  const { apiSession } = useSessionContext()

  React.useEffect(() => {
    const cancel = Effect.runCallback(
      apiSession.syncingInfo.pipe(Effect.tapSync(setSyncingInfo), Effect.tapCauseLogPretty),
    )
    return () => cancel()
  }, [apiSession.syncingInfo])

  const [syncHeadLeader, setSyncHeadLeader] = React.useState<
    typeof Devtools.Leader.SyncHeadRes.Type | undefined
  >(undefined)

  const [syncHeadClientSession, setSyncHeadClientSession] = React.useState<
    typeof Devtools.ClientSession.SyncHeadRes.Type | undefined
  >(undefined)

  React.useEffect(
    () =>
      apiSession.syncHeadLeader.pipe(
        Stream.tap((_) => Effect.sync(() => setSyncHeadLeader(_))),
        Stream.runDrain,
        Effect.tapCauseLogPretty,
        Effect.runCallback,
      ),
    [apiSession.syncHeadLeader],
  )

  React.useEffect(
    () =>
      apiSession.syncHeadClientSession.pipe(
        Stream.tap((_) => Effect.sync(() => setSyncHeadClientSession(_))),
        Stream.runDrain,
        Effect.tapCauseLogPretty,
        Effect.runCallback,
      ),
    [apiSession.syncHeadClientSession],
  )

  const now = useTick(1000, true)

  if (
    syncingInfo === undefined ||
    syncHeadClientSession === undefined ||
    syncHeadLeader === undefined
  ) {
    return <div className="p-2 text-xs">Loading...</div>
  }

  return (
    <div className="h-full flex flex-col bg-devtools-background">
      <div className="flex-shrink-0 p-4 pb-2 space-y-3">
        <div className="flex items-center space-x-3">
          <div
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              networkStatusArr.at(-1)?.devtools.latchClosed
                ? 'bg-orange-500'
                : networkStatusArr.at(-1)?.isConnected
                  ? 'bg-green-500'
                  : 'bg-red-500'
            }`}
          />
          <span className="text-sm text-devtools-text">
            {networkStatusArr.at(-1)?.devtools.latchClosed
              ? 'Paused'
              : networkStatusArr.at(-1)?.isConnected
                ? 'Connected'
                : 'Disconnected'}
          </span>
          <ConnectionStatusDetails networkStatusArr={networkStatusArr} now={now} inline />
          <DevToolsButton
            size="xs"
            onClick={() =>
              apiSession
                .setSyncLatch(!(networkStatusArr.at(-1)?.devtools.latchClosed ?? false))
                .pipe(Effect.tapCauseLogPretty, Effect.runPromise)
            }
          >
            {networkStatusArr.at(-1)?.devtools.latchClosed ? '▶︎ Resume' : '⏸︎ Pause'}
          </DevToolsButton>
          <div className="text-xs">
            <a
              href="https://livestore.dev/docs/reference/syncing/syncing/"
              target="_blank"
              rel="noreferrer"
              className="text-devtools-text-secondary hover:text-devtools-text underline"
            >
              How syncing works ↗
            </a>
          </div>
        </div>
        <div className="w-full overflow-hidden">
          <div className="flex items-center overflow-x-auto scrollbar-thin">
            {networkStatusArr.map((status, index) => {
              const nextStatus = networkStatusArr[index + 1]
              const duration = nextStatus
                ? nextStatus.timestampMs - status.timestampMs
                : now - status.timestampMs

              return (
                <div
                  key={status.timestampMs}
                  className={`h-3 flex-shrink-0 ${
                    status.devtools.latchClosed
                      ? 'bg-orange-500'
                      : status.isConnected
                        ? 'bg-green-500'
                        : 'bg-red-500'
                  } ${index === networkStatusArr.length - 1 ? '' : 'opacity-60'}`}
                  style={{ width: `${Math.max(duration / 1000, 8)}px` }}
                  title={`${status.devtools.latchClosed ? 'Paused' : status.isConnected ? 'Connected' : 'Disconnected'} • ${new Date(status.timestampMs).toLocaleString()}`}
                />
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-4 pt-2">
        <SyncGraph
          syncingInfo={syncingInfo}
          heads={{
            clientSession: syncHeadClientSession.local,
            clientLeader: syncHeadLeader.local,
            backend: syncHeadLeader.upstream,
          }}
        />
      </div>
    </div>
  )
}

const HeadInfo: React.FC<{
  head: EventSequenceNumber.Client.Composite
}> = ({ head }) => {
  const [isChanged, setIsChanged] = React.useState(false)
  const prevHeadRef = React.useRef({ global: head.global, client: head.client })

  React.useEffect(() => {
    if (prevHeadRef.current.global !== head.global || prevHeadRef.current.client !== head.client) {
      setIsChanged(true)
      const timer = setTimeout(() => setIsChanged(false), 200)
      prevHeadRef.current = { global: head.global, client: head.client }
      return () => clearTimeout(timer)
    }
    return undefined
  }, [head.global, head.client])

  return (
    <div
      className={cn('transition-colors duration-500 ease-in-out', isChanged ? 'text-red-500' : '')}
    >
      Head: {EventSequenceNumber.Client.toString(head)}
    </div>
  )
}

const SyncGraph: React.FC<{
  heads: {
    clientSession: EventSequenceNumber.Client.Composite
    clientLeader: EventSequenceNumber.Client.Composite
    backend: EventSequenceNumber.Client.Composite | undefined
  }
  syncingInfo: typeof Devtools.Leader.SyncingInfo.Type
}> = ({ heads, syncingInfo }) => {
  const allClientSessions = useClientSessions()
  const { apiSession } = useSessionContext()

  /**
   * Sort client sessions with the focused session (matching apiSession) always first,
   * then sort the rest alphabetically by sessionId
   */
  const sortedClientSessions = React.useMemo(
    () =>
      allClientSessions
        .filter((_) => _.storeId === apiSession.clientInfo.storeId)
        .sort((a, b) => {
          if (a.sessionId === apiSession.clientInfo.sessionId) return -1
          if (b.sessionId === apiSession.clientInfo.sessionId) return 1
          return a.sessionId.localeCompare(b.sessionId)
        }),
    [allClientSessions, apiSession.clientInfo.sessionId, apiSession.clientInfo.storeId],
  )

  const { nodes, edges } = React.useMemo(() => {
    const FOCUSSED_SESSION_NODE_HEIGHT = 54
    const OTHER_SESSION_NODE_HEIGHT = 36
    const CLIENTS_CONTAINER_PADDING = 16
    const SESSIONS_CONTAINER_PADDING_TOP = 16
    const SESSIONS_CONTAINER_PADDING_BOTTOM = 44
    const SESSIONS_CONTAINER_PADDING_X = 16
    const SESSIONS_NODE_GAP = 12
    const CLIENT_NODE_WIDTH = 300
    const CLIENT_NODE_GAP = 24

    const clientContainerHeight =
      FOCUSSED_SESSION_NODE_HEIGHT +
      OTHER_SESSION_NODE_HEIGHT * (sortedClientSessions.length - 1) +
      CLIENTS_CONTAINER_PADDING * 2 +
      SESSIONS_CONTAINER_PADDING_TOP +
      SESSIONS_CONTAINER_PADDING_BOTTOM +
      SESSIONS_NODE_GAP * (sortedClientSessions.length - 1)

    const clientContainerWidth =
      CLIENTS_CONTAINER_PADDING * 2 +
      SESSIONS_CONTAINER_PADDING_X * 2 +
      CLIENT_NODE_WIDTH * 2 +
      CLIENT_NODE_GAP

    let clientSessionTopOffset = SESSIONS_CONTAINER_PADDING_TOP

    const nodes: Reactflow.Node[] = [
      // Client container (group node)
      {
        id: 'client-container',
        type: 'client-container',
        position: { x: 0, y: 0 },
        data: {
          clientId: apiSession.clientInfo.clientId,
          clientSessions: sortedClientSessions.length,
        },
        style: {
          width: clientContainerWidth,
          height: clientContainerHeight,
          background: 'transparent',
        },
      },
      // Sessions container (group node)
      {
        id: 'sessions-container',
        type: 'sessions-container',
        position: { x: CLIENTS_CONTAINER_PADDING, y: CLIENTS_CONTAINER_PADDING },
        parentNode: 'client-container',
        extent: 'parent' as const,
        data: {
          clientSessions: sortedClientSessions.length,
        },
        style: {
          width: CLIENT_NODE_WIDTH + SESSIONS_CONTAINER_PADDING_X * 2,
          height:
            FOCUSSED_SESSION_NODE_HEIGHT +
            OTHER_SESSION_NODE_HEIGHT * (sortedClientSessions.length - 1) +
            SESSIONS_CONTAINER_PADDING_TOP +
            SESSIONS_CONTAINER_PADDING_BOTTOM +
            SESSIONS_NODE_GAP * (sortedClientSessions.length - 1),
          background: 'transparent',
        },
      },
      ...sortedClientSessions.map((session) => {
        const isFocused = session.sessionId === apiSession.clientInfo.sessionId

        const y = clientSessionTopOffset
        clientSessionTopOffset +=
          (isFocused ? FOCUSSED_SESSION_NODE_HEIGHT : OTHER_SESSION_NODE_HEIGHT) + SESSIONS_NODE_GAP

        return {
          id: `session-${session.sessionId}`,
          type: 'client-session',
          position: { x: SESSIONS_CONTAINER_PADDING_X, y },
          parentNode: 'sessions-container',
          extent: 'parent' as const,
          data: {
            id: session.sessionId,
            head: isFocused ? heads.clientSession : undefined,
            upstreamActual: isFocused ? heads.clientLeader : undefined,
            isFocused,
          },
          style: {
            width: CLIENT_NODE_WIDTH,
            height: isFocused ? FOCUSSED_SESSION_NODE_HEIGHT : OTHER_SESSION_NODE_HEIGHT,
          },
        }
      }),
      // Client leader node
      {
        id: 'client-leader',
        type: 'client-leader',
        position: {
          x:
            CLIENTS_CONTAINER_PADDING +
            CLIENT_NODE_WIDTH +
            SESSIONS_CONTAINER_PADDING_X * 2 +
            CLIENT_NODE_GAP,
          y: CLIENTS_CONTAINER_PADDING + SESSIONS_CONTAINER_PADDING_TOP,
        },
        parentNode: 'client-container',
        extent: 'parent' as const,
        data: {
          head: heads.clientLeader,
          upstreamActual: heads.backend?.global ?? EventSequenceNumber.Global.make(0),
        },
        style: {
          width: CLIENT_NODE_WIDTH,
        },
      },
      // Sync backend node
      {
        id: 'sync-backend',
        type: 'sync-backend',
        position: { x: clientContainerWidth + 40, y: 0 }, // Align with client container
        data: {
          enabled: syncingInfo.enabled,
          head: heads.backend ?? EventSequenceNumber.Client.ROOT,
          metadata: syncingInfo.metadata,
        },
        style: {
          width: 400,
        },
      },
    ] satisfies Reactflow.Node[]

    // Edge from leader to backend
    const edges: Reactflow.Edge[] = [
      ...sortedClientSessions.map((session) => ({
        id: `session-${session.sessionId}-to-leader`,
        source: `session-${session.sessionId}`,
        target: 'client-leader',
        type: 'default',
        style: {
          stroke: 'var(--devtools-text-secondary)',
          opacity: session.sessionId === apiSession.clientInfo.sessionId ? 1 : 0.4,
        },
      })),
      {
        id: 'leader-to-backend',
        source: 'client-leader',
        target: 'sync-backend',
        type: 'default',
        style: { stroke: 'var(--devtools-text-secondary)' },
      },
    ]

    // Post-process node positions
    return {
      nodes: nodes.map((node) => {
        if (node.parentId !== undefined) return node

        return {
          ...node,
          position: { x: node.position.x, y: node.position.y },
          style: {
            ...node.style,
            background: 'transparent',
            border: '1px solid var(--devtools-border)',
            borderRadius: '0.375rem',
          },
        }
      }),
      edges: edges.map((edge) => ({
        ...edge,
        // Add some curvature to the edges to make them more visually appealing
        type: 'default',
        style: {
          ...edge.style,
          stroke: 'var(--devtools-text-secondary)',
          strokeDasharray: '5,5',
          strokeWidth: 1,
        },
      })),
    }
  }, [apiSession, sortedClientSessions, heads, syncingInfo])

  const nodeTypes = React.useMemo(
    () => ({
      'client-container': ClientContainerNode,
      'sessions-container': SessionsContainerNode,
      'client-session': ClientSessionNode,
      'client-leader': ClientLeaderNode,
      'sync-backend': SyncBackendNode,
    }),
    [],
  )

  return (
    <div className="w-full h-full bg-devtools-background text-xs">
      <Reactflow.ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  )
}

type ClientContainerNodeData = {
  clientId: string
  clientSessions: number
}

const ClientContainerNode: React.FC<Reactflow.NodeProps<ClientContainerNodeData>> = ({ data }) => {
  return (
    <div className="border border-devtools-border bg-devtools-surface rounded p-3 flex flex-col justify-between h-full text-devtools-text">
      <div className="flex-1" /> {/* Spacer for child nodes */}
      <div className="flex justify-end">Client ({data.clientId})</div>
    </div>
  )
}

type SessionsContainerNodeData = {
  clientSessions: number
}

const SessionsContainerNode: React.FC<Reactflow.NodeProps<SessionsContainerNodeData>> = ({
  data,
}) => {
  return (
    <div className="border border-devtools-border bg-devtools-surface rounded p-2 flex flex-1 flex-col justify-between h-full text-devtools-text">
      <div className="flex-1" /> {/* Spacer for child nodes */}
      <div className="flex justify-end">Client Sessions ({data.clientSessions})</div>
    </div>
  )
}

type ClientSessionNodeData = {
  id: string
  head: EventSequenceNumber.Client.Composite | undefined
  upstreamActual: EventSequenceNumber.Client.Composite | undefined
  isFocused: boolean
}

const ClientSessionNode: React.FC<Reactflow.NodeProps<ClientSessionNodeData>> = ({ data }) => {
  return (
    <div
      className={cn(
        'border border-devtools-border bg-devtools-surface h-full rounded p-2 flex flex-1 flex-col justify-between w-full text-devtools-text',
        data.isFocused ? '' : 'opacity-40',
      )}
    >
      <div className="flex gap-2">
        {data.head !== undefined && <HeadInfo head={data.head} />}
        {data.upstreamActual !== undefined && data.head !== undefined && (
          <Status head={data.head} upstreamActual={data.upstreamActual} />
        )}
      </div>
      <div className="flex justify-end">Session ({data.id})</div>
      <Reactflow.Handle type="source" position={Reactflow.Position.Right} id="right" />
    </div>
  )
}

type ClientLeaderNodeData = {
  head: EventSequenceNumber.Client.Composite
  upstreamActual: EventSequenceNumber.Global.Type
}

const ClientLeaderNode: React.FC<Reactflow.NodeProps<ClientLeaderNodeData>> = ({ data }) => {
  return (
    <div className="border border-devtools-border bg-devtools-surface rounded p-2 flex flex-1 flex-col justify-between min-w-[200px] text-devtools-text">
      <div className="flex gap-2">
        <HeadInfo head={data.head} />
        <Status
          head={EventSequenceNumber.Client.Composite.make({ global: data.head.global, client: 0 })}
          upstreamActual={EventSequenceNumber.Client.Composite.make({
            global: data.upstreamActual,
            client: 0,
          })}
        />
      </div>
      <div className="flex justify-end">Client Leader</div>
      <Reactflow.Handle type="target" position={Reactflow.Position.Left} id="left" />
      <Reactflow.Handle type="source" position={Reactflow.Position.Right} id="right" />
    </div>
  )
}

const Status: React.FC<{
  head: EventSequenceNumber.Client.Composite
  upstreamActual: EventSequenceNumber.Client.Composite
  className?: string
}> = ({ head, upstreamActual, className }) => {
  const diff = React.useMemo(() => {
    const { global, client } = EventSequenceNumber.Client.diff(upstreamActual, head)
    return global + client
  }, [upstreamActual, head])

  const syncStatus = React.useMemo(() => {
    if (diff === 0) return 'synced'
    if (diff > 0) return `${diff} behind`
    return `${-diff} ahead`
  }, [diff])

  const statusIcon = React.useMemo(() => {
    if (diff === 0)
      return <Icons.CheckCircle className="w-3 h-3 text-green-500 dark:text-green-400" />
    if (diff > 0)
      return <Icons.CircleChevronDown className="w-3 h-3 text-orange-500 dark:text-orange-400" />
    return <Icons.CircleChevronUp className="w-3 h-3 text-yellow-600 dark:text-yellow-400" />
  }, [diff])

  return (
    <div className={cn('flex items-center text-[10px] gap-1', className)}>
      {statusIcon}
      {syncStatus}
    </div>
  )
}

type SyncBackendNodeData = {
  enabled: boolean
  head: EventSequenceNumber.Client.Composite
  metadata: Record<string, string>
}

const SyncBackendNode: React.FC<Reactflow.NodeProps<SyncBackendNodeData>> = ({ data }) => {
  const globalHead = React.useMemo(
    () => EventSequenceNumber.Client.Composite.make({ global: data.head.global, client: 0 }),
    [data.head],
  )

  return (
    <div className="border border-devtools-border bg-devtools-surface rounded p-3 flex flex-1 flex-col justify-between w-full text-devtools-text">
      {data.enabled && data.head !== undefined ? (
        <div className="flex flex-col gap-4">
          <HeadInfo head={globalHead} />
          <div className="flex flex-col gap-1.5">
            <div className="font-semibold">Metadata:</div>
            {Object.entries(data.metadata).map(([key, value]) => (
              <div key={key} className="ml-2">
                <span className="text-devtools-text-secondary">{key}: </span>
                <span className="text-devtools-text">{value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-center">No sync backend found</div>
      )}
      <div className="flex justify-end">Sync Backend</div>
      <Reactflow.Handle type="target" position={Reactflow.Position.Left} id="left" />
    </div>
  )
}
