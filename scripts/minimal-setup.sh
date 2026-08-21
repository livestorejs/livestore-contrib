#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

# This stays contrib-owned: a raw checkout must materialize pinned core before pnpm can install.
for tool in bun git node pnpm; do
  command -v "$tool" >/dev/null || {
    echo "Minimal Setup requires $tool on PATH." >&2
    exit 1
  }
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" != 24 ]; then
  echo "Minimal Setup requires Node.js major version 24 (found $(node --version))." >&2
  exit 1
fi

package_manager="$(bun -e 'console.log(require("./package.json").packageManager)')"
if [[ ! "$package_manager" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package.json#packageManager must pin pnpm exactly (found $package_manager)." >&2
  exit 1
fi

expected_pnpm_version="${package_manager#pnpm@}"
actual_pnpm_version="$(pnpm --version)"
if [ "$actual_pnpm_version" != "$expected_pnpm_version" ]; then
  echo "Minimal Setup requires pnpm $expected_pnpm_version (found $actual_pnpm_version)." >&2
  exit 1
fi

echo "Minimal Setup: Git $(git --version | cut -d' ' -f3), Node $(node --version), pnpm $actual_pnpm_version, Bun $(bun --version)"

core_url="$(bun -e 'const lock = await Bun.file("megarepo.lock").json(); console.log(lock.members.livestore.url)')"
core_commit="$(bun -e 'const lock = await Bun.file("megarepo.lock").json(); console.log(lock.members.livestore.commit)')"

if [ -L repos/livestore ]; then
  echo "repos/livestore is a symlink; use a separate checkout for Minimal Setup." >&2
  exit 1
fi

if [ -e repos/livestore ] && [ ! -d repos/livestore/.git ]; then
  echo "repos/livestore already exists but is not a Git checkout; use a separate checkout for Minimal Setup." >&2
  exit 1
fi

mkdir -p repos/livestore
git -C repos/livestore init --initial-branch=main
# Refuse ambiguous ownership rather than overwrite another setup flow's core checkout.
if ! git -C repos/livestore diff --quiet || [ -n "$(git -C repos/livestore status --short)" ]; then
  echo "repos/livestore has local changes; use a clean, exclusively owned checkout." >&2
  exit 1
fi
git -C repos/livestore fetch --depth=1 "$core_url" "$core_commit"
git -C repos/livestore checkout --detach FETCH_HEAD
test "$(git -C repos/livestore rev-parse HEAD)" = "$core_commit"

pnpm install --frozen-lockfile
echo "Minimal Setup ready. Run a focused task from contributor-docs/development/minimal-setup.md."
