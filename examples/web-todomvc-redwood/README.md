# TodoMVC Redwood Example

This example wires the LiveStore TodoMVC components into the Redwood SDK (rwsdk) worker + client runtime.

## Running locally

```bash
pnpm install
pnpm --filter livestore-example-web-todomvc-redwood dev
```

The Redwood dev server chooses its own port; watch the terminal output for the correct URL.

## Known issues

- `rwsdk@1.0.0-beta.12` is still beta software and may surface runtime incompatibilities as its React Server Components integration evolves.
- The starter's worker configuration is included verbatim; we have not validated deployment to Cloudflare or RSC behaviour yet.

Run the smoke test locally with `pnpm --filter livestore-example-web-todomvc-redwood test:e2e`.

## To-do

- [ ] Make SSR work properly with LiveStore initialization
