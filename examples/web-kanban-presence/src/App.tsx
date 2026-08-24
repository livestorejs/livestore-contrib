import React from 'react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  getFirstCollision,
  pointerWithin,
  useDndMonitor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { StoreRegistry } from '@livestore/livestore'
import { StoreRegistryProvider } from '@livestore/react'
import { Effect } from '@livestore/utils/effect'

import type { CursorState } from './livestore/presence-schemas.ts'
import { presenceSchemas } from './livestore/presence-schemas.ts'
import { columns$, cards$ } from './livestore/queries.ts'
import { events } from './livestore/schema.ts'
import { useAppStore } from './livestore/store.ts'
import {
  usePresenceClient,
  usePresenceSnapshot,
} from './presence/hooks.ts'
import { getStoreId } from './util/store-id.ts'

const COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#06b6d4']

const errorBoundaryFallback = <div>Something went wrong</div>
const DraggerColorContext = React.createContext<string>('#3b82f6')
export const useDraggerColor = () => React.useContext(DraggerColorContext)

const DraggerMonitor: React.FC<{ onChange: (id: string | null) => void }> = ({ onChange }) => {
  useDndMonitor({
    onDragStart: (e) => onChange(String(e.active.id)),
    onDragEnd: () => onChange(null),
    onDragCancel: () => onChange(null),
  })
  return null
}
const suspenseFallback = <div>Loading app...</div>

type Card = { id: string; title: string; columnId: string }

/**
 * Prefer the innermost droppable under the pointer (a card over its column),
 * so dragging onto a card reorders it and the column highlight only appears
 * when hovering empty column space.
 */
const innermostCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  if (pointerCollisions.length > 0) {
    // Order by droppable rect area ascending → smallest (innermost) first.
    const byArea = [...pointerCollisions].sort((a, b) => {
      const ra = args.droppableContainers.find((c) => c.id === a.id)?.rect.current
      const rb = args.droppableContainers.find((c) => c.id === b.id)?.rect.current
      return (ra ? ra.width * ra.height : Infinity) - (rb ? rb.width * rb.height : Infinity)
    })
    return byArea
  }
  return closestCorners(args)
}

const SortableCard: React.FC<{ card: Card; dragging?: boolean }> = ({ card, dragging }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card' as const, columnId: card.columnId, cardId: card.id },
  })

  return (
    <div
      ref={setNodeRef}
      className="kanban-card"
      data-card-id={card.id}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
      {...listeners}
    >
      {card.title}
    </div>
  )
}

const KanbanColumn: React.FC<{
  column: { id: string; title: string }
  cards: Card[]
  onAddCard: (title: string) => void
  onDelete: () => void
  newCardTitle: string
  onNewCardTitle: (title: string) => void
  draggerColor: string
}> = ({ column, cards, onAddCard, onDelete, newCardTitle, onNewCardTitle, draggerColor }) => {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' as const, columnId: column.id } })

  return (
    <div
      ref={setNodeRef}
      className="kanban-column"
      data-column-id={column.id}
      style={{ outline: isOver ? `2px solid ${draggerColor}` : undefined }}
    >
      <div className="kanban-column-header">
        <h3 className="kanban-column-title">{column.title}</h3>
        <button className="kanban-column-delete" onClick={onDelete} aria-label={`Delete ${column.title}`}>
          ×
        </button>
      </div>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="kanban-cards">
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} />
          ))}
        </div>
      </SortableContext>
      <div className="kanban-add-card">
        <input
          placeholder="New card"
          value={newCardTitle}
          onChange={(e) => onNewCardTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAddCard(newCardTitle)}
        />
        <button onClick={() => onAddCard(newCardTitle)}>Add</button>
      </div>
    </div>
  )
}

export const App: React.FC = () => {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <ErrorBoundary fallback={errorBoundaryFallback}>
      <Suspense fallback={suspenseFallback}>
        <StoreRegistryProvider storeRegistry={storeRegistry}>
          <KanbanBoard />
        </StoreRegistryProvider>
      </Suspense>
    </ErrorBoundary>
  )
}

const KanbanBoard: React.FC = () => {
  const store = useAppStore()
  const storeId = getStoreId()

  const columns = store.useQuery(columns$)
  const cards = store.useQuery(cards$)

  // Ephemeral presence: online count + live cursors + live dragging.
  // Broadcast-only; never persisted to SQLite or the eventlog. Rides the same
  // sync party (`/sync`) — single party hosts both the durable eventlog and
  // the ephemeral presence room.
  //
  // clientId is stable per browser tab (sessionStorage), so a refresh rejoins
  // as the same member instead of adding a duplicate; `leave` fires on tab
  // close via the `pagehide` handler below.
  const [userName, setUserName] = useState(
    () => globalThis.localStorage?.getItem('kanban-name') ?? '',
  )
  const presenceOptions = useMemo(
    () => ({
      url: `${globalThis.location.origin}/sync`,
      storeId,
      clientId: `client-${crypto.randomUUID().slice(0, 8)}`,
      name: globalThis.localStorage?.getItem('kanban-name') || 'Guest',
      payload: { authToken: 'insecure-token-change-me' },
      channels: presenceSchemas,
    }),
    [storeId],
  )
  const presence = usePresenceClient(presenceOptions)
  const presenceSnapshot = usePresenceSnapshot(presence)
  const onlineCount = presenceSnapshot.members.filter((m) => m.online === true).length
  // Own member state first so you can see exactly what peers see (dimmed).
  const cursors = presenceSnapshot.members.flatMap((m) => {
    const state = m.state as CursorState | undefined
    return m.online === true && state?.cursor !== undefined
      ? [{
          clientId: m.clientId,
          name: m.name,
          cursor: state.cursor,
          isSelf: m.clientId === presence.clientId,
        }]
      : []
  })
  // Remote drags: card + position of the dragging peer's cursor.
  const remoteDrags = presenceSnapshot.members.flatMap((m) => {
    const state = m.state as CursorState | undefined
    return m.clientId !== presence.clientId && m.online === true && state?.dragging !== undefined
      ? [{ clientId: m.clientId, name: m.name, dragging: state.dragging }]
      : []
  })

  const applyName = useCallback(
    (name: string) => {
      setUserName(name)
      globalThis.localStorage?.setItem('kanban-name', name)
      if (name.trim() !== '') {
        Effect.runFork(presence.setState('cursor', { name: name.trim() }))
      }
    },
    [presence],
  )

  const [draggerId, setDraggerId] = useState<string | null>(null)
  const changeUserName = useCallback(
    (name: string) => {
      const next = name.trim() === '' ? 'Guest' : name
      setUserName(next)
      globalThis.localStorage?.setItem('kanban-name', next)
      if (next.trim() !== '') {
        Effect.runFork(presence.setState('cursor', { name: next }))
      }
    },
    [presence],
  )

  const [newColumnTitle, setNewColumnTitle] = useState('')
  const [newCardTitles, setNewCardTitles] = useState<Record<string, string>>({})
  const [activeCard, setActiveCard] = useState<Card | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const addColumn = useCallback(() => {
    if (!newColumnTitle.trim()) return
    store.commit(
      events.columnCreated({
        id: crypto.randomUUID(),
        title: newColumnTitle.trim(),
        position: columns.length,
      }),
    )
    setNewColumnTitle('')
  }, [newColumnTitle, columns.length, store])

  const addCard = useCallback(
    (columnId: string, title: string) => {
      if (!title.trim()) return
      const cardsInColumn = cards.filter((c) => c.columnId === columnId)
      store.commit(
        events.cardCreated({
          id: crypto.randomUUID(),
          title: title.trim(),
          columnId,
          position: cardsInColumn.length,
        }),
      )
      setNewCardTitles((prev) => ({ ...prev, [columnId]: '' }))
    },
    [cards, store],
  )

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id)
      const card = cards.find((c) => c.id === id) ?? null
      setActiveCard(card)
      if (card !== null) {
        Effect.runFork(presence.setState('cursor', { dragging: { cardId: card.id, deltaX: 0, deltaY: 0 } }))
      }
    },
    [cards, presence],
  )

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const id = String(event.active.id)
      const { x, y } = event.delta
      // Broadcast the running drag delta; peers render the ghost at their own
      // view of this client's cursor plus the delta, so no drift accumulates.
      Effect.runFork(presence.setState('cursor', { dragging: { cardId: id, deltaX: x, deltaY: y } }))
    },
    [presence],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCard(null)
      Effect.runFork(presence.setState('cursor', { dragging: undefined }))
      const { active, over } = event
      if (over === null) return

      const card = cards.find((c) => c.id === active.id)
      if (card === undefined) return

      const overData = over.data.current
      const overType = overData?.type
      const targetColumnId =
        overType === 'column'
          ? (overData?.columnId as string)
          : overType === 'card'
            ? (overData?.columnId as string)
            : card.columnId

      // Column order (durable positions) for the target column, before the move.
      const targetCards = cards.filter((c) => c.columnId === targetColumnId)
      const targetIds = targetCards.map((c) => c.id)

      if (overType === 'card' && targetColumnId === card.columnId) {
        // Reorder within the same column: rewrite every position so the
        // durable positions stay contiguous (0..n-1).
        const oldIndex = targetIds.indexOf(card.id)
        const newIndex = targetIds.indexOf(String(over.id))
        const reordered = arrayMove(targetIds, oldIndex, newIndex)
        reordered.forEach((id, position) => {
          store.commit(events.cardMoved({ id, columnId: targetColumnId, position }))
        })
      } else if (card.columnId !== targetColumnId) {
        // Cross-column move: append to the target column.
        store.commit(events.cardMoved({ id: card.id, columnId: targetColumnId, position: targetIds.length }))
      } else if (overType === 'column') {
        // Dropped on a column (empty space): reorder to the end.
        const oldIndex = targetIds.indexOf(card.id)
        if (oldIndex !== targetIds.length - 1) {
          store.commit(events.cardMoved({ id: card.id, columnId: targetColumnId, position: targetIds.length - 1 }))
        }
      }
    },
    [cards, store, presence],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (presence !== undefined) {
        Effect.runFork(presence.setState('cursor', { cursor: { x: e.clientX, y: e.clientY } }))
      }
    },
    [presence],
  )

  const deleteColumn = useCallback(
    (columnId: string) => {
      store.commit(events.columnDeleted({ id: columnId }))
    },
    [store],
  )

  const draggerColor = draggerId !== null ? (COLORS[Math.abs(hashString(draggerId)) % COLORS.length] ?? '#3b82f6') : '#3b82f6'
  return (
    <DraggerColorContext.Provider value={draggerColor}>
      <DraggerMonitor onChange={setDraggerId} />
      <DndContext
      sensors={sensors}
      collisionDetection={innermostCollisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
    >
      <div className="kanban" ref={boardRef} onPointerMove={handlePointerMove}>
        <header className="kanban-header">
          <h1>Kanban</h1>
          <div className="kanban-meta">
            <span className="online-count" data-testid="online-count">
              {onlineCount} online
            </span>
            <input
              className="name-input"
              placeholder="Your name"
              value={userName}
              onChange={(e) => applyName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              onBlur={() => {
                if (userName.trim() === '') changeUserName('Guest')
              }}
            />
            <input
              className="new-column-input"
              placeholder="New column title"
              value={newColumnTitle}
              onChange={(e) => setNewColumnTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addColumn()}
            />
            <button onClick={addColumn}>Add column</button>
          </div>
        </header>

        {/* Live cursors overlay — Figma-style arrow + name label. Includes the
            local client so you can verify exactly what peers see. */}
        <div className="cursor-layer">
          {cursors.map(({ clientId: cid, name, cursor }) => {
            const color = COLORS[Math.abs(hashString(cid)) % COLORS.length]
            const isSelf = cid === presence.clientId
            return (
              <div
                key={cid}
                className="cursor"
                data-testid={`cursor-${cid}`}
                style={{ left: cursor.x, top: cursor.y, opacity: isSelf ? 0.45 : 1 }}
              >
                <div className="cursor-name" style={{ backgroundColor: color }}>
                  {name ?? cid}
                </div>
                <svg className="cursor-pointer" width="20" height="20" viewBox="0 0 24 24" fill={color}>
                  <path d="M4 2l16 11.5h-6.9L9.6 22 4 2z" />
                </svg>
              </div>
            )
          })}
        </div>

        {/* Live drag overlay — the dragged card rendered with the exact dnd-kit
            card UI (same tilt) at the peer's cursor. The peer's cursor is their
            real pointer position, so following it is drift-free. */}
        <div className="drag-layer">
          {remoteDrags.map(({ clientId: cid, name, dragging }) => {
            const cursor = cursors.find((c) => c.clientId === cid)?.cursor
            if (cursor === undefined) return null
            return (
              <div
                key={cid}
                className="kanban-card kanban-card-dragging remote-drag-card"
                data-testid={`drag-${cid}`}
                style={{
                  left: cursor.x,
                  top: cursor.y,
                  width: cardWidth(dragging.cardId),
                }}
              >
                {cardTitle(dragging.cardId, cards)}
                <span
                  className="remote-drag-name"
                  style={{ backgroundColor: COLORS[Math.abs(hashString(cid)) % COLORS.length] }}
                >
                  {name ?? cid}
                </span>
              </div>
            )
          })}
        </div>

        <div className="kanban-board">
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              cards={cards.filter((c) => c.columnId === column.id)}
              newCardTitle={newCardTitles[column.id] ?? ''}
              onNewCardTitle={(title) => setNewCardTitles((prev) => ({ ...prev, [column.id]: title }))}
              onAddCard={(title) => addCard(column.id, title)}
              onDelete={() => deleteColumn(column.id)}
              draggerColor={draggerColor}
            />
          ))}
        </div>

        <DragOverlay>
          {activeCard !== null ? (
            <div className="kanban-card kanban-card-dragging">{activeCard.title}</div>
          ) : null}
        </DragOverlay>
      </div>
    </DndContext>
    </DraggerColorContext.Provider>
  )
}

const hashString = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

const cardTitle = (cardId: string, cards: readonly Card[]) => cards.find((c) => c.id === cardId)?.title ?? cardId

/** Measured pixel width of a rendered card, so remote drag ghosts match exactly. */
const cardWidth = (cardId: string) =>
  document.querySelector(`[data-card-id="${cardId}"]`)?.getBoundingClientRect().width ?? 200