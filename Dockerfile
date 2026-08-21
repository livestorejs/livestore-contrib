FROM node:24.18.1-bookworm AS node

# Bun 1.3.13 is the known-good Minimal Setup runtime; Node stays on supported major 24.
FROM oven/bun:1.3.13-debian

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY . .

# Containers install the repository pin; host-native setup requires that exact pnpm on PATH.
RUN npm install --global "$(bun -e 'console.log(require("./package.json").packageManager)')"

# The same host-native bootstrap owns tool checks, exact core materialization, and install.
RUN ./scripts/minimal-setup.sh

RUN pnpm --dir packages/@livestore/solid exec tsc -b ../../../tsconfig.dev.json --pretty false

RUN pnpm --dir packages/@livestore/cli exec vitest run --config vitest.config.ts \
    && WORKSPACE_ROOT=/workspace pnpm --dir packages/@livestore/svelte exec vitest run --config tests/vitest.config.ts \
    && pnpm --dir packages/@livestore/sync-s2 exec vitest run --config vitest.config.ts

RUN pnpm --dir packages/@livestore/cli exec bun src/bin.ts --help

RUN WORKSPACE_ROOT=/workspace pnpm --dir tests/integration exec vitest run --config src/tests/node-misc/vitest.config.ts

RUN pnpm --dir examples/web-todomvc-solid run build

RUN pnpm --dir examples/web-todomvc-solid exec wrangler deploy --dry-run --outdir /tmp/wrangler-web-todomvc-solid
