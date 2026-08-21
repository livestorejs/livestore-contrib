FROM node:24.18.1-bookworm AS node

FROM oven/bun:1.3.13-debian

COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY . .

RUN set -eux; \
    package_manager="$(bun -e 'console.log(require("./package.json").packageManager)')"; \
    bun install --global "$package_manager"; \
    bun --version; \
    node --version; \
    pnpm --version

RUN set -eux; \
    core_url="$(bun -e 'const lock = await Bun.file("megarepo.lock").json(); console.log(lock.members.livestore.url)')"; \
    core_commit="$(bun -e 'const lock = await Bun.file("megarepo.lock").json(); console.log(lock.members.livestore.commit)')"; \
    mkdir -p repos/livestore; \
    git -C repos/livestore init; \
    git -C repos/livestore fetch --depth=1 "$core_url" "$core_commit"; \
    git -C repos/livestore checkout --detach FETCH_HEAD; \
    test "$(git -C repos/livestore rev-parse HEAD)" = "$core_commit"

RUN pnpm install --frozen-lockfile

RUN pnpm --dir packages/@livestore/solid exec tsc -b ../../../tsconfig.dev.json --pretty false

RUN pnpm --dir packages/@livestore/cli exec vitest run --config vitest.config.ts \
    && WORKSPACE_ROOT=/workspace pnpm --dir packages/@livestore/svelte exec vitest run --config tests/vitest.config.ts \
    && pnpm --dir packages/@livestore/sync-s2 exec vitest run --config vitest.config.ts

RUN pnpm --dir packages/@livestore/cli exec bun src/bin.ts --help

RUN WORKSPACE_ROOT=/workspace pnpm --dir tests/integration exec vitest run --config src/tests/node-misc/vitest.config.ts

RUN pnpm --dir examples/web-todomvc-solid run build

RUN pnpm --dir examples/web-todomvc-solid exec wrangler deploy --dry-run --outdir /tmp/wrangler-web-todomvc-solid
