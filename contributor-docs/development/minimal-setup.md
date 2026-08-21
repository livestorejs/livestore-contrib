# Minimal Setup

Minimal Setup is the default for ordinary contrib TypeScript work. Its boundary
comes from the core [developer-environment spec](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/01-developer-environment/spec.md)
and [requirements R02-R06](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/01-developer-environment/requirements.md#requirements).

## Prerequisites

Use each tool's official installation guidance. The bootstrap verifies versions
and exits before installation if the checkout does not meet these requirements.

| Tool | Requirement | Official installation | Verify |
| --- | --- | --- | --- |
| Git | Available on `PATH` | [Git downloads](https://git-scm.com/downloads) | `git --version` |
| Node.js | Major version 24 | [Node.js download](https://nodejs.org/en/download) | `node --version` |
| Bun | Available on `PATH`; 1.3.13 is the Docker-tested version | [Bun installation](https://bun.sh/docs/installation) | `bun --version` |
| pnpm | Exact version in `package.json#packageManager` | [pnpm installation](https://pnpm.io/installation) | `pnpm --version` |

## Bootstrap

From a fresh, exclusively owned checkout:

```bash
./scripts/minimal-setup.sh
```

The script verifies the toolchain, materializes the exact core revision from
`megarepo.lock` at `repos/livestore`, and performs a frozen workspace install.
It does not install or upgrade host tools. It refuses a non-Git or dirty core
checkout rather than overwriting state owned by another setup flow.

## Common tasks

| Task | Command |
| --- | --- |
| Build the TypeScript project graph | `pnpm --dir packages/@livestore/solid exec tsc -b ../../../tsconfig.dev.json` |
| Run a focused package suite | `pnpm --dir packages/@livestore/cli exec vitest run --config vitest.config.ts` |
| Build the representative web example | `pnpm --dir examples/web-todomvc-solid run build` |

## Optional Docker environment

The root Dockerfile is the finite cold-start oracle used by CI. Compose exposes
the same image as an interactive shell without prescribing application ports:

```bash
docker compose build
LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)" docker compose run --rm dev
./scripts/minimal-setup.sh
```

Compose maps the caller's numeric ownership and uses a temporary writable home.
It bind-mounts the checkout, so do not let host and container setup processes
write the same checkout concurrently. Use a separate checkout when ownership
would otherwise be ambiguous.

Minimal Setup intentionally excludes generators, browser and Playwright tests,
Expo native/runtime validation, release operations, and publication. Use
[Full Setup](./full-setup.md) when work reaches those seams.
