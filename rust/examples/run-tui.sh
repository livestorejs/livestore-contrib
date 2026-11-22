#!/usr/bin/env bash
# Runs the terminal TodoMVC against a local sync server.
# Defaults match core's web example (examples/web-todomvc-sync-cf, `pnpm dev`), so the
# TUI and the web app share one store. Override with STORE, URL, DATA or CLIENT.
set -euo pipefail
cd "$(dirname "$0")/todo-tui"
store="${STORE:-rust-demo}"
url="${URL:-ws://localhost:60001/sync}"
data="${DATA:-$PWD/../.data/tui${CLIENT:+-$CLIENT}}"
run=(cargo run --quiet --bin todo -- --url "$url" --store "$store" --data "$data")
if command -v cargo >/dev/null; then exec "${run[@]}"; fi
# No Rust toolchain on PATH: use the repo's devenv shell (it lives at the repo root).
here="$PWD"
cd "$(git rev-parse --show-toplevel)"
exec devenv shell -- bash -c 'cd "$1" && shift && exec "$@"' _ "$here" "${run[@]}"
