/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Event IDs, scroll state, and component colors are bound at their leaf views. */
import { useLayoutEffect, useRef } from 'react'

import type { ComponentSyncObservation, ObservedEvent } from '../../model.ts'
import type { ObservedSystemState, ProjectedClient } from '../../projection.ts'
import { eventTooltipContent } from '../event-tooltip.ts'
import { clientColor, displayEventPosition } from '../timeline-scene.ts'
import { StatusBadge, type StatusTone } from './Primitives.tsx'
import { Tooltip, type TooltipContent } from './Tooltip.tsx'

const pendingBoundaryTooltipContent = {
  title: 'Pending boundary',
  details: [{ label: 'Following events', value: 'Awaiting upstream confirmation' }],
} satisfies TooltipContent

export interface EventLogScrollState {
  readonly followTail: boolean
  readonly scrollLeft: number
}

export const EventChip = ({
  event,
  originColor,
  selected,
  onSelect,
}: {
  readonly event: ObservedEvent
  readonly originColor?: string
  readonly selected: boolean
  readonly onSelect: (eventRef: string) => void
}) => (
  <Tooltip content={eventTooltipContent(event)}>
    <button
      type="button"
      className={`event-chip ${event.disposition} ${selected === true ? 'selected' : ''}`}
      data-origin-client-id={event.origin.clientId}
      style={originColor === undefined ? undefined : ({ '--event-origin-color': originColor } as React.CSSProperties)}
      onClick={() => onSelect(event.eventRef)}
    >
      {displayEventPosition(event)}
    </button>
  </Tooltip>
)

export const EventLog = ({
  eventlogKey,
  events,
  label,
  selectedEventRef,
  scrollStates,
  clientIds,
  onSelectEvent,
}: {
  readonly eventlogKey: string
  readonly events: ReadonlyArray<ObservedEvent>
  readonly label: string
  readonly selectedEventRef?: string
  readonly scrollStates?: Map<string, EventLogScrollState>
  readonly clientIds?: ReadonlyArray<string>
  readonly onSelectEvent: (eventRef: string) => void
}) => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || scrollStates === undefined) return
    const state = scrollStates.get(eventlogKey) ?? { followTail: true, scrollLeft: 0 }
    const maximumScrollLeft = Math.max(element.scrollWidth - element.clientWidth, 0)
    element.scrollLeft = state.followTail === true ? maximumScrollLeft : Math.min(state.scrollLeft, maximumScrollLeft)
    scrollStates.set(eventlogKey, { followTail: state.followTail, scrollLeft: element.scrollLeft })
  }, [eventlogKey, events, scrollStates])
  return (
    <div className="eventlog-block">
      <p className="eyebrow">{label}</p>
      <div
        ref={ref}
        className="eventlog"
        data-eventlog-key={eventlogKey}
        aria-label={label}
        onScroll={(event) => {
          if (scrollStates === undefined) return
          const element = event.currentTarget
          const maximumScrollLeft = Math.max(element.scrollWidth - element.clientWidth, 0)
          scrollStates.set(eventlogKey, {
            followTail: maximumScrollLeft - element.scrollLeft <= 2,
            scrollLeft: element.scrollLeft,
          })
        }}
      >
        <div className="eventlog-track">
          {events.length === 0 ? <span className="summary">No events observed</span> : null}
          {events.map((event, index) => (
            <span key={`${event.eventRef}:${index}`} style={{ display: 'contents' }}>
              {event.disposition === 'pending' && events[index - 1]?.disposition !== 'pending' ? (
                <Tooltip content={pendingBoundaryTooltipContent}>
                  <span
                    className="eventlog-pending-boundary"
                    tabIndex={0}
                    aria-label="Events after this marker are awaiting upstream confirmation"
                  />
                </Tooltip>
              ) : null}
              <EventChip
                event={event}
                originColor={eventOriginColor(event, clientIds)}
                selected={event.eventRef === selectedEventRef}
                onSelect={onSelectEvent}
              />
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export const SyncRoleRow = ({
  label,
  sync,
  health,
  actionLabel,
  onAction,
}: {
  readonly label: string
  readonly sync: ComponentSyncObservation | null
  readonly health?: 'unknown' | 'healthy' | 'failed'
  readonly actionLabel?: string
  readonly onAction?: () => void
}) => (
  <div className={`role-row ${health === 'failed' ? 'runtime-failed' : ''}`}>
    <strong>{label}</strong>
    <span>
      {sync === null
        ? 'not observed'
        : `local ${sync.localHead} · upstream ${sync.upstreamHead} · ${sync.pendingCount} pending`}
      {health === 'failed' ? (
        <>
          {' · '}
          <em className="runtime-health">runtime failed</em>
        </>
      ) : null}
    </span>
    {actionLabel !== undefined && onAction !== undefined ? (
      <button type="button" className="text-button" onClick={onAction}>
        {actionLabel}
      </button>
    ) : null}
  </div>
)

export const BackendCard = ({
  backend,
  selectedEventRef,
  scrollStates,
  clientIds,
  onSelectEvent,
}: {
  readonly backend: ObservedSystemState['backend']
  readonly selectedEventRef?: string
  readonly scrollStates?: Map<string, EventLogScrollState>
  readonly clientIds?: ReadonlyArray<string>
  readonly onSelectEvent: (eventRef: string) => void
}) => {
  const status = backend === null ? 'unobserved' : backend.connected === true ? 'online' : 'offline'
  const tone: StatusTone = backend === null ? 'neutral' : backend.connected === true ? 'good' : 'bad'
  return (
    <article className="component-card" style={{ '--component-color': '#4169e1' } as React.CSSProperties}>
      <div className="component-title">
        <h3>Sync backend</h3>
        <StatusBadge tone={tone}>{status}</StatusBadge>
      </div>
      <EventLog
        eventlogKey="backend"
        events={backend?.events ?? []}
        label={backend === null ? 'No backend observation yet' : `Authoritative head ${backend.head}`}
        selectedEventRef={selectedEventRef}
        scrollStates={scrollStates}
        clientIds={clientIds}
        onSelectEvent={onSelectEvent}
      />
    </article>
  )
}

export const ClientCard = ({
  client,
  index,
  selectedEventRef,
  scrollStates,
  clientIds,
  onSelectEvent,
  onOpenLeaderState,
}: {
  readonly client: ProjectedClient
  readonly index: number
  readonly selectedEventRef?: string
  readonly scrollStates?: Map<string, EventLogScrollState>
  readonly clientIds?: ReadonlyArray<string>
  readonly onSelectEvent: (eventRef: string) => void
  readonly onOpenLeaderState?: (clientId: string) => void
}) => {
  const [status, tone] = clientStatus(client)
  return (
    <article className="component-card" style={{ '--component-color': clientColor(index) } as React.CSSProperties}>
      <div className="component-title">
        <h3>{client.clientId}</h3>
        <StatusBadge tone={tone}>{status}</StatusBadge>
      </div>
      <EventLog
        eventlogKey={`client:${client.clientId}`}
        events={client.leader?.events ?? []}
        label={
          client.leader === null ? 'Leader not observed' : `Client eventlog · ${client.leader.pendingCount} pending`
        }
        selectedEventRef={selectedEventRef}
        scrollStates={scrollStates}
        clientIds={clientIds}
        onSelectEvent={onSelectEvent}
      />
      <div className="role-list">
        <SyncRoleRow
          label="Leader role"
          sync={client.leader}
          health={client.health === 'failed' ? 'failed' : undefined}
          actionLabel={
            client.leader === null || onOpenLeaderState === undefined ? undefined : 'open reconstructed State'
          }
          onAction={
            client.leader === null || onOpenLeaderState === undefined
              ? undefined
              : () => onOpenLeaderState(client.clientId)
          }
        />
        {client.sessions.map((session) => (
          <SyncRoleRow
            key={session.sessionId}
            label={`Session ${session.sessionId}`}
            sync={session.sync}
            health={session.health}
          />
        ))}
      </div>
    </article>
  )
}

export const SystemTopology = ({
  state,
  selectedEventRef,
  scrollStates,
  onSelectEvent,
  onOpenLeaderState,
}: {
  readonly state: ObservedSystemState
  readonly selectedEventRef?: string
  readonly scrollStates?: Map<string, EventLogScrollState>
  readonly onSelectEvent: (eventRef: string) => void
  readonly onOpenLeaderState?: (clientId: string) => void
}) => {
  const clientIds = state.clients.map((client) => client.clientId)
  return (
    <div className="topology">
      <BackendCard
        backend={state.backend}
        selectedEventRef={selectedEventRef}
        scrollStates={scrollStates}
        clientIds={clientIds}
        onSelectEvent={onSelectEvent}
      />
      {state.clients.map((client, index) => (
        <ClientCard
          key={client.clientId}
          client={client}
          index={index}
          selectedEventRef={selectedEventRef}
          scrollStates={scrollStates}
          clientIds={clientIds}
          onSelectEvent={onSelectEvent}
          onOpenLeaderState={onOpenLeaderState}
        />
      ))}
    </div>
  )
}

const eventOriginColor = (event: ObservedEvent, clientIds: ReadonlyArray<string> | undefined): string | undefined => {
  const index = clientIds?.indexOf(event.origin.clientId) ?? -1
  return index < 0 ? undefined : clientColor(index)
}

const clientStatus = (client: ProjectedClient): readonly [string, StatusTone] => {
  if (client.health === 'failed' || client.health === 'degraded') return [client.health, 'bad']
  if (client.connected === false) return ['offline', 'bad']
  if (client.leader === null) return ['unobserved', 'neutral']
  if (client.leader.pendingCount > 0) return [`${client.leader.pendingCount} pending`, 'warn']
  if (globalPosition(client.leader.localHead) !== globalPosition(client.leader.upstreamHead))
    return ['catching up', 'warn']
  return ['synced', 'good']
}

const globalPosition = (head: string): number => Number(head.match(/^e(\d+)/)?.[1] ?? -1)
