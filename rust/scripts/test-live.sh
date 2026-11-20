#!/usr/bin/env bash
# Starts a throwaway local sync-cf backend (wrangler dev) on a free port, runs every
# livestore-sync-cf test against it (transport, sync loop, the ported sync-provider suite,
# DO hibernation, Rust<->TypeScript e2e via bun), and always stops it.
# Uses the worker of the megarepo-pinned core (`repos/livestore`).
# Extra args go to cargo test, e.g. `scripts/test-live.sh --test e2e_ts`.
set -euo pipefail

crate_dir="$(cd "$(dirname "$0")/.." && pwd)"
core="$(cd "$crate_dir/.." && pwd)/repos/livestore"
wrangler="$core/packages/@livestore/utils-dev/node_modules/.bin/wrangler"

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
state_dir="$(mktemp -d)"
log="$state_dir/wrangler.log"

# Core's tests/sync-provider and examples are not contrib workspace members, so stage the worker
# and the TodoMVC schema (for the e2e TS client) next to links to the installed core packages.
worker_dir="$state_dir/worker"
mkdir -p "$worker_dir/node_modules/@livestore"
cp "$core"/tests/sync-provider/src/providers/cloudflare/*.{ts,toml} "$worker_dir/"
for pkg in adapter-cloudflare common common-cf livestore sync-cf utils; do
  ln -s "$core/packages/@livestore/$pkg" "$worker_dir/node_modules/@livestore/$pkg"
done
cp "$core/examples/web-todomvc-sync-cf/src/livestore/schema.ts" "$worker_dir/todomvc-schema.ts"

(cd "$worker_dir" && exec "$wrangler" dev --config wrangler-do-sqlite.toml --port "$port" \
  --inspector-port 0 --persist-to "$state_dir/state") >"$log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$state_dir"; }
trap cleanup EXIT

for _ in $(seq 1 120); do
  grep -q "Ready on" "$log" && break
  kill -0 "$pid" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 0.5
done
grep -q "Ready on" "$log" || { cat "$log"; echo "wrangler did not start" >&2; exit 1; }

cd "$crate_dir"
LIVESTORE_SYNC_URL="ws://localhost:$port" LIVESTORE_TODOMVC_SCHEMA="$worker_dir/todomvc-schema.ts" cargo test --locked -p livestore-sync-cf "$@"
