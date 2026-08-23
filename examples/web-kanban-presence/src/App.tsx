import type React from 'react'
import { Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  getFirstCollision,
  pointerWithin,
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

import { columns$, cards$ } from './livestore/queries.ts'
import { events } from './livestore/schema.ts'
import { useAppStore } from './livestore/store.ts'
import {
  useOnlineCount,
  usePresenceCursors,
  usePresenceDragging,
  usePresenceWsClient,
} from './presence/hooks.ts'
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
  newCardTitle: string
  onNewCardTitle: (title: string) => void
}> = ({ column, cards, onAddCard, newCardTitle, onNewCardTitle }) => {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' as const, columnId: column.id } })

  return (
    <div
      ref={setNodeRef}
      className="kanban-column"
      data-column-id={column.id}
      style={{ outline: isOver ? '2px solid #3b82f6' : undefined }}
    >
      <h3 className="kanban-column-title">{column.title}</h3>
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
    }),
    [storeId],
  )
  const presence = usePresenceWsClient(presenceOptions)
  const onlineCount = useOnlineCount(presence)
  const cursors = usePresenceCursors(presence)
  const draggingPeers = usePresenceDragging(presence)

  const changeUserName = useCallback(
    (name: string) => {
      setUserName(name)
      globalThis.localStorage?.setItem('kanban-name', name)
      if (name.trim() !== '') {
        Effect.runFork(presence.setName(name.trim()))
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
        Effect.runFork(presence.setDragging({ cardId: card.id, deltaX: 0, deltaY: 0 }))
      }
    },
    [cards, presence],
  )

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const id = String(event.active.id)
      const { x, y } = event.delta
      Effect.runFork(presence.setDragging({ cardId: id, deltaX: x, deltaY: y }))
    },
    [presence],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCard(null)
      Effect.runFork(presence.setDragging(undefined))
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
        Effect.runFork(presence.setCursor(e.clientX, e.clientY))
      }
    },
    [presence],
  )

  return (
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
              onChange={(e) => changeUserName(e.target.value)}
              onBlur={() => userName.trim() === '' && changeUserName('Guest')}
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

        {/* Live cursors overlay — Supabase-style pointer + name label */}
        <div className="cursor-layer">
          {cursors.map(({ clientId: cid, name, cursor }) => {
            const color = COLORS[Math.abs(hashString(cid)) % COLORS.length]
            return (
              <div
                key={cid}
                className="cursor"
                data-testid={`cursor-${cid}`}
                style={{ left: cursor.x, top: cursor.y }}
              >
                <svg
                  className="cursor-pointer"
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill={color}
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M5.65376 12.2373l5.16266-8.48998c.22842-.37383.42723-.70011.59823-.99242.171-.29232.30251-.58008.39451-.86329.092-.28321.13801-.57109.13801-.86367 0-.27921-.0425-.52456-.12751-.73607-.08502-.2115-.21533-.38815-.39093-.52995-.1756-.1418-.40713-.21269-.69459-.21269-.04029 0-.12442.00262-.25237.00787-.12795.00525-.2945.02661-.49965.06408s-.37423.10196-.59489.20329c-.22067.10133-.45557.23458-.70472.39974-.24914.16517-.51169.38153-.78764.64908l-9.43087 9.20246c-.26937.26353-.46713.48297-.59327.65832-.12614.17534-.22678.35627-.30193.54278-.07516.1865-.11274.37872-.11274.57666 0 .19205.03346.38369.1004.57492.06693.19123.15868.36712.27526.52766.11657.16055.2484.29321.39547.398s.31329.17615.47692.21932c.16364.04316.32419.06475.48167.06475h7.91005c.30934 0 .61555-.04682.91864-.14046s.56033-.23262.77063-.41668c.21029-.18406.3833-.40238.51903-.65497.13573-.25259.20356-.52657.20356-.82193 0-.1418-.00864-.30282-.02591-.48305-.01727-.18023-.05133-.36956-.10217-.56799z" />
                </svg>
                <div className="cursor-name" style={{ backgroundColor: color }}>
                  {name ?? cid}
                </div>
              </div>
            )
          })}
        </div>

        {/* Live drag overlay — the dragged card rendered with the exact dnd-kit
            card UI at the peer's cursor, mirroring their local DragOverlay. */}
        <div className="drag-layer">
          {draggingPeers.map(({ clientId: cid, name, dragging }) => {
            const cursor = cursors.find((c) => c.clientId === cid)?.cursor
            if (cursor === undefined) return null
            return (
              <div
                key={cid}
                className="kanban-card remote-drag-card"
                data-testid={`drag-${cid}`}
                style={{
                  left: cursor.x + dragging.deltaX,
                  top: cursor.y + dragging.deltaY,
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