/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Story render functions intentionally construct isolated examples. */
import type { Meta, StoryObj } from '@storybook/react-vite'

import type { ObservedEvent } from '../../model.ts'
import type { ObservedSystemState } from '../../projection.ts'
import { StatusBadge } from './Primitives.tsx'
import { BackendCard, ClientCard, EventChip, EventLog, SyncRoleRow, SystemTopology } from './SystemTopology.tsx'

const meta = {
  title: 'Viewer/Primitives and topology',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const event = (position: string, disposition: 'confirmed' | 'pending' = 'confirmed'): ObservedEvent => ({
  eventRef: `event-${position}`,
  name: 'todo.created',
  args: { id: `todo-${position}` },
  origin: { clientId: 'client-a', sessionId: 'session-a' },
  position,
  parentPosition: position,
  disposition,
})
const confirmedEvents = Array.from({ length: 7 }, (_, index) => event(`e${index + 1}`))
const overflowEvents = Array.from({ length: 40 }, (_, index) =>
  event(`e${index + 1}`, index >= 34 ? 'pending' : 'confirmed'),
)
const sync = { localHead: 'e7', upstreamHead: 'e7', pendingCount: 0, events: confirmedEvents }
const topology: ObservedSystemState = {
  cursorIndex: 20,
  runStatus: 'running',
  verdicts: [],
  backend: { id: 'backend', connected: true, head: 'e7', events: confirmedEvents },
  clients: [
    {
      clientId: 'client-a',
      lifecycle: 'created',
      health: 'healthy',
      connected: true,
      leader: sync,
      sessions: [
        { sessionId: 'session-a1', lifecycle: 'created', health: 'healthy', sync },
        { sessionId: 'session-a2-with-a-very-long-identifier', lifecycle: 'created', health: 'failed', sync: null },
      ],
    },
    {
      clientId: 'client-b-offline',
      lifecycle: 'created',
      health: 'degraded',
      connected: false,
      leader: { ...sync, pendingCount: 3, events: [...confirmedEvents, event('e8', 'pending')] },
      sessions: [{ sessionId: 'session-b', lifecycle: 'created', health: 'unknown', sync: null }],
    },
  ],
}

export const StatusBadgeTones: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 20 }}>
      <StatusBadge>unobserved</StatusBadge>
      <StatusBadge tone="good">synced</StatusBadge>
      <StatusBadge tone="warn">3 pending</StatusBadge>
      <StatusBadge tone="bad">failed</StatusBadge>
    </div>
  ),
}

export const EventChipStates: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <EventChip event={event('e1')} selected={false} onSelect={() => undefined} />
      <EventChip event={event('e2', 'pending')} selected={false} onSelect={() => undefined} />
      <EventChip event={event('e3')} selected onSelect={() => undefined} />
      <EventChip event={event('e4', 'pending')} selected onSelect={() => undefined} />
    </div>
  ),
}

export const EventLogStates: Story = {
  render: () => (
    <div className="topology">
      <EventLog eventlogKey="empty" events={[]} label="Empty" onSelectEvent={() => undefined} />
      <EventLog eventlogKey="single" events={[event('e1')]} label="Single" onSelectEvent={() => undefined} />
      <EventLog
        eventlogKey="sequence"
        events={confirmedEvents}
        label="Confirmed sequence"
        onSelectEvent={() => undefined}
      />
      <EventLog
        eventlogKey="pending"
        events={[...confirmedEvents, event('e8', 'pending'), event('e9', 'pending')]}
        label="Pending suffix"
        selectedEventRef="event-e8"
        onSelectEvent={() => undefined}
      />
      <div style={{ maxWidth: 420 }}>
        <EventLog
          eventlogKey="overflow"
          events={overflowEvents}
          label="Overflow and follow tail"
          onSelectEvent={() => undefined}
        />
      </div>
    </div>
  ),
}

export const SyncRoleStates: Story = {
  render: () => (
    <div className="role-list">
      <SyncRoleRow label="Unobserved" sync={null} />
      <SyncRoleRow label="Synced" sync={sync} health="healthy" />
      <SyncRoleRow label="Catching up" sync={{ ...sync, upstreamHead: 'e9' }} />
      <SyncRoleRow label="Pending" sync={{ ...sync, pendingCount: 2 }} />
      <SyncRoleRow label="Runtime failed" sync={sync} health="failed" />
    </div>
  ),
}

export const BackendAndClientCards: Story = {
  render: () => (
    <div className="topology">
      <BackendCard backend={topology.backend} onSelectEvent={() => undefined} />
      <ClientCard client={topology.clients[0]!} index={0} onSelectEvent={() => undefined} />
    </div>
  ),
}

export const SystemTopologyConditions: Story = {
  render: () => <SystemTopology state={topology} selectedEventRef="event-e4" onSelectEvent={() => undefined} />,
}

export const SystemTopologyUnobserved: Story = {
  render: () => (
    <SystemTopology
      state={{
        ...topology,
        cursorIndex: -1,
        runStatus: 'not-started',
        backend: null,
        clients: topology.clients.map((client) => ({
          ...client,
          health: 'unknown',
          connected: null,
          leader: null,
          sessions: client.sessions.map((session) => ({
            ...session,
            lifecycle: 'declared',
            health: 'unknown',
            sync: null,
          })),
        })),
      }}
      onSelectEvent={() => undefined}
    />
  ),
}
