# Kanban with presence

A kanban board on LiveStore with ephemeral multi-tab presence.

- **Durable board** — columns and cards are synced state: committed events are
  materialized into SQLite (OPFS in the browser) and distributed through the
  `@livestore/sync-cf` backend. Refresh-safe and multi-tab consistent.
- **Ephemeral presence** — online-count badge, live cursors, and live drag
  broadcast via `@livestore/sync-cf/presence`. Presence is broadcast-only and
  never touches the eventlog or SQLite.
- **Drag & drop** with dnd-kit — cards reorder within a column and move across
  columns. The drag is broadcast live to peers.

## Run

```bash
pnpm install
pnpm --filter livestore-example-web-kanban-presence dev
```

The Vite dev server starts the app and the Cloudflare Worker that hosts both
the durable eventlog and presence on the same `/sync` WebSocket.

Open the printed local URL, add a column and some cards, then open a second
tab to see the online count, live cursors, and live drags.

## Deploy (Cloudflare)

```bash
pnpm --filter livestore-example-web-kanban-presence run build
pnpm --filter livestore-example-web-kanban-presence exec wrangler deploy
```

## Features

- Online count badge (from the presence room snapshot)
- Live cursors for every connected client
- Live drag broadcast — peers see which card you're dragging and where
- Drag & drop cards between columns (durable `cardMoved` events)
- SQLite-persistent board via OPFS + sync backend
