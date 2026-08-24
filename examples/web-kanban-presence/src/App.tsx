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
import { usePresenceClient, usePresenceSnapshot } from './presence/hooks.ts'
import { getStoreId } from './util/store-id.ts'

const COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#06b6d4']

const errorBoundaryFallback = <div>Something went wrong</div>
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

const SortableCard: React.FC<{
  card: Card
  isActiveDrag: boolean
  isDropTarget: boolean
  dropColor: string | undefined
}> = ({ card, isActiveDrag, isDropTarget, dropColor }) => {
  const { attributes, listeners, setNodeRef } = useSortable({
    id: card.id,
    data: { type: 'card' as const, columnId: card.columnId, cardId: card.id },
  })

  return (
    <div
      ref={setNodeRef}
      className="kanban-card"
      data-card-id={card.id}
      style={{
        opacity: isActiveDrag ? 0.3 : 1,
        outline: isDropTarget ? `2px dashed ${dropColor ?? '#3b82f6'}` : undefined,
        outlineOffset: '-2px',
      }}
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
  hoverColor: string | undefined
  activeDragId: string | null
  overCardId: string | null
}> = ({ column, cards, onAddCard, onDelete, newCardTitle, onNewCardTitle, hoverColor, activeDragId, overCardId }) => {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' as const, columnId: column.id } })

  return (
    <div
      ref={setNodeRef}
      className="kanban-column"
      data-column-id={column.id}
      style={{ outline: isOver && hoverColor !== undefined ? `2px solid ${hoverColor}` : undefined }}
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
            <SortableCard
              key={card.id}
              card={card}
              isActiveDrag={activeDragId === card.id}
              isDropTarget={overCardId === card.id}
              dropColor={hoverColor}
            />
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

/** Tracks the currently-dragging client's id via dnd-kit monitor. Must be rendered inside DndContext. */
const DragTracker: React.FC<{ onChange: (clientId: string | null) => void }> = ({ onChange }) => {
  useDndMonitor({
    onDragStart: (event) => onChange(String(event.active.id)),
    onDragEnd: () => onChange(null),
    onDragCancel: () => onChange(null),
  })
  return null
}

const KanbanBoard: React.FC = () => {
  const store = useAppStore()
  const storeId = getStoreId()

  const columns = store.useQuery(columns$)
  const cards = store.useQuery(cards$)

  // Ephemeral presence: online count + live cursors + live dragging.
  // Broadcast-only; never persisted to SQLite or the eventlog. Rides the same
  // sync party (`/sync`) — single party hosts both the durable eventlog and
  // the ephemeral presence room. The party evicts members on socket close.
  //
  // clientId is fresh per tab mount; the party's socket-close handler evicts
  // the old member when this one replaces it.
  const presenceOptions = useMemo(
    () => ({
      url: `${globalThis.location.origin}/sync`,
      storeId,
      clientId: `client-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Guest',
      payload: { authToken: 'insecure-token-change-me' },
      channels: presenceSchemas,
    }),
    [storeId],
  )
  const presence = usePresenceClient(presenceOptions)
  const presenceSnapshot = usePresenceSnapshot(presence)

  const onlineCount = presenceSnapshot.members.filter((m) => m.online === true).length

  // Assign a sequential default name once we know how many people are online.
  const [nameAssigned, setNameAssigned] = useState(false)
  useEffect(() => {
    if (nameAssigned === false && onlineCount > 0) {
      setNameAssigned(true)
      Effect.runFork(presence.setState('cursor', { name: `Guest ${onlineCount}` }))
    }
  }, [onlineCount, nameAssigned, presence])

  // Leave explicitly on tab close so peers update instantly.
  useEffect(() => {
    const onPageHide = () => {
      Effect.runFork(presence.leave)
    }
    globalThis.addEventListener('pagehide', onPageHide)
    return () => {
      globalThis.removeEventListener('pagehide', onPageHide)
    }
  }, [presence])

  // All cursors including self (self is dimmed).
  const cursors = presenceSnapshot.members.flatMap((m) => {
    const state = m.state as CursorState | undefined
    return m.online === true && state?.cursor !== undefined
      ? [{
          clientId: m.clientId,
          name: state.name ?? m.name ?? 'Guest',
          cursor: state.cursor,
          color: COLORS[Math.abs(hashString(m.clientId)) % COLORS.length] ?? '#3b82f6',
          isSelf: m.clientId === presence.clientId,
        }]
      : []
  })

  // Remote drags with the dragger's color for ghost outline.
  const remoteDrags = presenceSnapshot.members.flatMap((m) => {
    const state = m.state as CursorState | undefined
    return m.clientId !== presence.clientId && m.online === true && state?.dragging !== undefined
      ? [{
          clientId: m.clientId,
          dragging: state.dragging,
          color: COLORS[Math.abs(hashString(m.clientId)) % COLORS.length] ?? '#3b82f6',
        }]
      : []
  })

  // Map of clientId → cursor position for remote drag ghosts to follow.
  const cursorByClient = useMemo(
    () => new Map(cursors.map((c) => [c.clientId, c.cursor])),
    [cursors],
  )

  const [userName, setUserName] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  const changeUserName = useCallback(
    (name: string) => {
      setUserName(name)
      if (name.trim() !== '') {
        Effect.runFork(presence.setState('cursor', { name: name.trim() }))
      }
    },
    [presence],
  )

  const submitName = useCallback(() => {
    if (nameInputRef.current !== null) {
      changeUserName(nameInputRef.current.value)
    }
  }, [changeUserName])

  const [newColumnTitle, setNewColumnTitle] = useState('')
  const [newCardTitles, setNewCardTitles] = useState<Record<string, string>>({})
  const [activeCard, setActiveCard] = useState<Card | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [overCardId, setOverCardId] = useState<string | null>(null)
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

  const deleteColumn = useCallback(
    (columnId: string) => {
      store.commit(events.columnDeleted({ id: columnId }))
    },
    [store],
  )

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id)
      const card = cards.find((c) => c.id === id) ?? null
      setActiveCard(card)
      setActiveDragId(id)
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
      Effect.runFork(presence.setState('cursor', { dragging: { cardId: id, deltaX: x, deltaY: y } }))
      // Track drop-target card for outline highlight
      if (event.over !== null && event.over.data.current?.type === 'card' && String(event.over.id) !== id) {
        setOverCardId(String(event.over.id))
      } else {
        setOverCardId(null)
      }
    },
    [presence],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCard(null)
      setActiveDragId(null)
      setOverCardId(null)
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

  // Column hover color follows the currently-dragging client's assigned color.
  const activeDraggerColor = remoteDrags.length > 0 ? (remoteDrags[0]?.color ?? '#3b82f6') : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={innermostCollisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveCard(null)
        setActiveDragId(null)
        setOverCardId(null)
        Effect.runFork(presence.setState('cursor', { dragging: undefined }))
      }}
    >
      <DragTracker onChange={(id) => { /* no-op: dragger tracked via presence */ }} />
      <div className="kanban" ref={boardRef} onPointerMove={handlePointerMove}>
        <header className="kanban-header">
          <h1>Kanban</h1>
          <div className="kanban-meta">
            <span className="online-count" data-testid="online-count">
              {onlineCount} online
            </span>
            <input
              ref={nameInputRef}
              className="name-input"
              placeholder="Your name"
              defaultValue={userName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  submitName()
                  e.currentTarget.blur()
                }
              }}
              onBlur={submitName}
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

        {/* Live cursors — Figma-style arrow + name label above. Self is dimmed;
            peers render at full opacity in their assigned color. */}
        <div className="cursor-layer">
          {cursors.map(({ clientId: cid, name, cursor, color, isSelf }) => (
            <div
              key={cid}
              className="cursor"
              data-testid={`cursor-${cid}`}
              style={{ left: cursor.x, top: cursor.y, opacity: isSelf ? 0.45 : 1 }}
            >
              <div className="cursor-name" style={{ backgroundColor: color }}>
                {name}
              </div>
              <svg className="cursor-pointer" width="20" height="20" viewBox="0 0 24 24" fill={color}>
                <path d="M4 2l16 11.5h-6.9L9.6 22 4 2z" />
              </svg>
            </div>
          ))}
        </div>

        {/* Live drag overlay — renders the dragged card at the peer's real
            pointer position with the peer's color as outline. No drift because
            we follow their cursor directly. */}
        <div className="drag-layer">
          {remoteDrags.map(({ clientId: cid, dragging, color }) => {
            const cursor = cursorByClient.get(cid)
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
                  outline: `2px solid ${color}`,
                }}
              >
                {cardTitle(dragging.cardId, cards)}
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
              hoverColor={activeDraggerColor}
              activeDragId={activeDragId}
              overCardId={overCardId}
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