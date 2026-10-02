# TodoMVC + celld Sync

TodoMVC whose Cloudflare sync backend (`@livestore/sync-cf`) runs on
[celld](https://github.com/denoland/celld), a self-hosted runtime for Workers
and Durable Objects. The sync worker is the same code as the Cloudflare
example; only the runtime changes.

## Running locally

Install the `celld` binary from the
[celld releases](https://github.com/denoland/celld/releases) and put it on your
`PATH`. Tested with celld v0.6.1. `celld dev` bundles the worker with esbuild,
so `esbuild` must be on `PATH` too, or set `CELLD_ESBUILD` to its path.

Start the sync backend and the app in two terminals:

```bash
pnpm dev:sync   # celld dev: the sync worker on http://127.0.0.1:9876
pnpm dev        # Vite: the app on http://localhost:60001, proxies /sync to celld
```

`celld dev` keeps its state in `.celld/dev`. Set `CELLD_URL` if celld listens
somewhere else.

## Configuration

celld reads `wrangler.json` (not TOML). It contains the `SYNC_BACKEND_DO`
binding and the SQLite migration that the Cloudflare example also uses.

For a production fleet (several nodes sharing an S3-compatible bucket), deploy
with `celld deploy . --bucket …` and run `celld --bucket …` on each node. See
the [celld documentation](https://celld.dev/docs). celld is alpha software.

## Tests

```bash
pnpm test:e2e
```

Playwright starts `celld dev` and Vite, then checks that todos sync between two
isolated browser contexts. The test needs `celld` on `PATH`, so it is not part
of the default `test` script that CI runs.
