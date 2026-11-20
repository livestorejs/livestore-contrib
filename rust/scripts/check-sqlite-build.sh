#!/usr/bin/env bash
# Compares the Rust client's SQLite build with the wa-sqlite build LiveStore loads.
# Usage: rust/scripts/check-sqlite-build.sh [--refresh]
#   --refresh re-dumps fixtures/sqlite/wa-sqlite.json from the pinned core wa-sqlite dist (needs bun).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$here/fixtures/sqlite/wa-sqlite.json"
if [ "${1:-}" = "--refresh" ]; then
  bun "$here/scripts/dump-wa-sqlite-build.ts"
fi
rust="$(mktemp)"
trap 'rm -f "$rust"' EXIT
(cd "$here" && cargo run -q -p livestore-sqlite --example dump_sqlite_build) > "$rust"
python3 - "$fixture" "$rust" <<'PY'
import json, sys
wasm, native = (json.load(open(p)) for p in sys.argv[1:])
# Justified native deviations (see crates/livestore-sqlite-sys/build.rs NATIVE_DEFINES).
ALLOWED = {
    "THREADSAFE=0", "THREADSAFE=2",  # rusqlite refuses THREADSAFE=0; connections move across tokio threads
    "MUTEX_OMIT", "MUTEX_PTHREADS",  # follow from THREADSAFE
}
# Connection-level values that are not build configuration.
for pragmas in (wasm["pragmas"], native["pragmas"]):
    pragmas.pop("busy_timeout")  # rusqlite's Connection::open sets busy_timeout(5s)
    pragmas.pop("cache_spill")   # derived from the page-header size, which depends on pointer width (wasm32 vs 64-bit)
strip = lambda opts: {o for o in opts if not o.startswith("COMPILER=")}  # toolchain name, not configuration
diffs = 0
for key in ("version", "sourceId", "pragmas", "modules", "functions", "probes"):
    if wasm[key] != native[key]:
        diffs += 1
        print(f"DIFF {key}:\n  wa-sqlite: {wasm[key]}\n  native:    {native[key]}")
only_wasm, only_native = strip(wasm["compileOptions"]) - strip(native["compileOptions"]), strip(native["compileOptions"]) - strip(wasm["compileOptions"])
print("compile options only in wa-sqlite:", sorted(only_wasm))
print("compile options only in native:   ", sorted(only_native))
unexpected = (only_wasm | only_native) - ALLOWED
if unexpected:
    diffs += 1
    print("UNEXPECTED compile option diff:", sorted(unexpected))
print("OK: identical apart from the allow-list" if diffs == 0 else f"{diffs} difference(s)")
sys.exit(1 if diffs else 0)
PY
