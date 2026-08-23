# Kanban with Presence

A partykit-style kanban board built fully on LiveStore:

- **Durable board** — columns and cards are synced state: committed events are
  materialized into SQLite (OPFS in the browser) and distributed through the
  `@livestore/sync-cf` backend. Refresh-safe and multi-tab consistent.
- **Ephemeral presence** — online-count badge, live cursors, and live drag
  broadcast via the presence channel (`@livestore/sync-cf/presence`). Presence
  is broadcast-only and never touches the eventlog, SQLite, or the sync backend.
- **Drag & drop** with dnd-kit — cards reorder within a column and move across
  columns, and the drag is broadcast live to peers (PartyKit-style `dragging`).

## Run

```bash
pnpm install
pnpm --filter livestore-example-web-kanban-presence dev
```

The Vite dev server starts both the app (via the Cloudflare Vite plugin, for
the durable board's sync DO) and a Node presence server on `ws://127.0.0.1:8787`
(see the `presenceServerPlugin` in `vite.config.ts`).

Open `http://localhost:60004`, add a column and some cards, then open a second
tab in the same browser to see the online count, live cursors, and live drags.

## Tests

Playwright e2e (single + multitab presence):

```bash
pnpm --filter livestore-example-web-kanban-presence test
```

## Deploy (Cloudflare)

```bash
pnpm --filter livestore-example-web-kanban-presence run build
pnpm --filter livestore-example-web-kanban-presence exec wrangler deploy
```

In production the presence channel is served by the
`PresenceDurableObject` in `@livestore/sync-cf/cf-worker`; the app's
`src/cf-worker/index.ts` routes `/presence` WebSocket upgrades to it.

## Features

- Online count badge (drives off the presence room snapshot)
- Live cursors for every connected client (pointer moves broadcast over presence)
- Live drag broadcast — peers see which card you're dragging and where
- Drag & drop cards between columns (durable `cardMoved` events)
- SQLite-persistent board via OPFS + sync backend