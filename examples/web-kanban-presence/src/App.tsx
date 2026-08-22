import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { Effect } from '@livestore/utils/effect'

import { columns$, cards$ } from './livestore/queries.ts'
import { events } from './livestore/schema.ts'
import { useAppStore } from './livestore/store.ts'
import { useOnlineCount, usePresenceClient, usePresenceCursors } from './presence/hooks.ts'
import { getStoreId } from './util/store-id.ts'

const COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#06b6d4']

const KanbanColumn = ({
  column,
  cards,
  onDrop,
}: {
  column: { id: string; title: string }
  cards: Array<{ id: string; title: string; columnId: string }>
  onDrop: (cardId: string, columnId: string) => void
}) => (
  <div
    className="kanban-column"
    data-column-id={column.id}
    onDragOver={(e) => e.preventDefault()}
    onDrop={(e) => {
      e.preventDefault()
      const cardId = e.dataTransfer.getData('text/cardId')
      if (cardId) onDrop(cardId, column.id)
    }}
  >
    <h3 className="kanban-column-title">{column.title}</h3>
    <div className="kanban-cards">
      {cards.map((card) => (
        <div
          key={card.id}
          className="kanban-card"
          draggable
          data-card-id={card.id}
          onDragStart={(e) => e.dataTransfer.setData('text/cardId', card.id)}
        >
          {card.title}
        </div>
      ))}
    </div>
  </div>
)

export const App: React.FC = () => {
  const store = useAppStore()
  const storeId = getStoreId()

  const columns = store.useQuery(columns$)
  const cards = store.useQuery(cards$)

  // Ephemeral presence: online count + live cursors. Broadcast-only; never
  // persisted to SQLite or the eventlog.
  const presenceUrl = `ws://${globalThis.location.hostname}:8787`
  const clientId = useMemo(() => (globalThis as any).__KANBAN_CLIENT_ID ?? `client-${crypto.randomUUID().slice(0, 8)}`, [])
  const presence = usePresenceClient({ url: presenceUrl, storeId, clientId, name: clientId })
  const onlineCount = useOnlineCount(presence)
  const cursors = usePresenceCursors(presence)

  const [newColumnTitle, setNewColumnTitle] = useState('')
  const [newCardTitles, setNewCardTitles] = useState<Record<string, string>>({})
  const boardRef = useRef<HTMLDivElement>(null)

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
    (columnId: string) => {
      const title = newCardTitles[columnId]?.trim()
      if (!title) return
      const cardsInColumn = cards.filter((c) => c.columnId === columnId)
      store.commit(
        events.cardCreated({
          id: crypto.randomUUID(),
          title,
          columnId,
          position: cardsInColumn.length,
        }),
      )
      setNewCardTitles((prev) => ({ ...prev, [columnId]: '' }))
    },
    [newCardTitles, cards, store],
  )

  const moveCard = useCallback(
    (cardId: string, targetColumnId: string) => {
      const cardsInTarget = cards.filter((c) => c.columnId === targetColumnId)
      store.commit(events.cardMoved({ id: cardId, columnId: targetColumnId, position: cardsInTarget.length }))
    },
    [cards, store],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (presence !== undefined) {
        Effect.runSync(presence.setCursor(e.clientX, e.clientY))
      }
    },
    [presence],
  )

  return (
    <div className="kanban" ref={boardRef} onPointerMove={handlePointerMove}>
      <header className="kanban-header">
        <h1>Kanban</h1>
        <div className="kanban-meta">
          <span className="online-count" data-testid="online-count">
            {onlineCount} online
          </span>
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

      {/* Live cursors overlay */}
      <div className="cursor-layer">
        {cursors.map(({ clientId: cid, name, cursor }) => (
          <div
            key={cid}
            className="cursor"
            data-testid={`cursor-${cid}`}
            style={{
              left: cursor.x,
              top: cursor.y,
              backgroundColor: COLORS[Math.abs(hashString(cid)) % COLORS.length],
            }}
          >
            <span className="cursor-label">{name ?? cid}</span>
          </div>
        ))}
      </div>

      <div className="kanban-board">
        {columns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            cards={cards.filter((c) => c.columnId === column.id)}
            onDrop={moveCard}
          />
        ))}
      </div>
    </div>
  )
}

const hashString = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}