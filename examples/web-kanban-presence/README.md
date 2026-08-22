# Kanban with Presence

A partykit-style kanban board built fully on LiveStore:

- **Durable board** — columns and cards are synced state: committed events are
  materialized into SQLite (OPFS in the browser) and distributed through the
  `@livestore/sync-cf` backend. Refresh-safe and multi-tab consistent.
- **Ephemeral presence** — online count and live cursors via the presence
  channel (`@livestore/sync-cf/presence`). Presence is broadcast-only and never
  touches the eventlog, SQLite, or the sync backend.

## Run

```bash
pnpm install
pnpm --filter livestore-example-web-kanban-presence dev
```

The board syncs through a Cloudflare Durable Object:

```bash
pnpm --filter livestore-example-web-kanban-presence run build
pnpm --filter livestore-example-web-kanban-presence exec wrangler dev
```

## Tests

Playwright e2e (single + multitab presence):

```bash
pnpm --filter livestore-example-web-kanban-presence test
```

For a local multitab run without Cloudflare, start the presence Node server
(`makeNodePresenceServerSelfContained` in `@livestore/sync-cf/presence`) on
port 8787 and point the app at it.

## Features

- Online count badge (drives off the presence room snapshot)
- Live cursors for every connected client (pointer moves broadcast over presence)
- Drag & drop cards between columns (durable `cardMoved` events)
- SQLite-persistent board via OPFS + sync backend