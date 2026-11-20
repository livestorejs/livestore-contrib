#!/usr/bin/env bash
# Compares the SQLite behavior Rust connections get (rusqlite bundled + configure_connection) with the wa-sqlite build
# LiveStore loads, read live from the pinned core in repos/livestore. Known differences are allow-listed below; any
# new difference fails.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
wasm="$(mktemp)"
rust="$(mktemp)"
trap 'rm -f "$wasm" "$rust"' EXIT
bun "$here/scripts/dump-wa-sqlite-build.ts" > "$wasm"
(cd "$here" && cargo run -q -p livestore-sqlite --example dump_sqlite_build) > "$rust"
python3 - "$wasm" "$rust" <<'PY'
import json, sys
wasm, native = (json.load(open(p)) for p in sys.argv[1:])

# wa-sqlite's extension-functions.c (core registers it; LiveStore itself does not call these).
EXTENSION_FUNCTIONS = {
    "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "atn2", "ceil", "charindex", "cos", "cosh", "cot",
    "coth", "degrees", "difference", "exp", "floor", "leftstr", "log", "log10", "lower_quartile", "median", "mode",
    "padc", "padl", "padr", "pi", "power", "proper", "radians", "replicate", "reverse", "rightstr", "sin", "sinh",
    "sqrt", "square", "stdev", "strfilter", "tan", "tanh", "upper_quartile", "variance",
}
# Extra features in rusqlite's bundled build that LiveStore does not use.
RUSQLITE_FUNCTIONS = {
    "bm25", "fts3_tokenizer", "fts5", "fts5_get_locale", "fts5_insttoken", "fts5_locale", "fts5_source_id",
    "highlight", "load_extension", "matchinfo", "offsets", "optimize", "rtreecheck", "rtreedepth", "rtreenode",
    "snippet", "soundex",
}
ALLOWED_MODULES = {
    "bytecode", "tables_used",  # wa-sqlite ENABLE_BYTECODE_VTAB; the Rust client derives tables used from the query plan
    "dbstat", "fts3", "fts3tokenize", "fts4", "fts4aux", "fts5", "fts5vocab", "rtree", "rtree_i32",  # rusqlite extras
}
ALLOWED_PROBES = {
    "bytecode",       # see ALLOWED_MODULES
    "dbstat", "fts5", "rtree",  # rusqlite extras
    "likeBlob",       # wa-sqlite LIKE_DOESNT_MATCH_BLOBS; no runtime switch
    "loadExtension",  # wa-sqlite omits it; rusqlite compiles it but keeps it disabled ("not authorized")
}
ALLOWED_PRAGMAS = {
    "busy_timeout",  # rusqlite's Connection::open sets 5s; wa-sqlite has a single connection
    "cache_spill",   # derived from the page-header size, which depends on pointer width (wasm32 vs 64-bit)
    "mmap_size",     # emscripten has no mmap (0); native in-memory DBs report nothing; both never mmap
}
ALLOWED_COMPILE_OPTIONS = {
    # wa-sqlite only
    "DEFAULT_MEMSTATUS=0", "USE_ALLOCA", "OMIT_AUTOINIT", "OMIT_DEPRECATED", "OMIT_SHARED_CACHE", "OMIT_DECLTYPE",
    "ENABLE_BATCH_ATOMIC_WRITE", "MAX_MMAP_SIZE=0", "MAX_WORKER_THREADS=0", "OMIT_LOAD_EXTENSION",
    "THREADSAFE=0", "MUTEX_OMIT",
    "DQS=0",                     # applied at runtime: SQLITE_DBCONFIG_DQS_DML/DDL off (probes dqsSelect, dqsDdl)
    "LIKE_DOESNT_MATCH_BLOBS",   # probe likeBlob
    "MAX_EXPR_DEPTH=0",          # wa-sqlite: unlimited; rusqlite: 1000
    "ENABLE_BYTECODE_VTAB",
    "DEFAULT_WAL_SYNCHRONOUS=1", "DEFAULT_WAL_SYNCHRONOUS=2",  # LiveStore does not use WAL
    # rusqlite bundled only
    "DEFAULT_FOREIGN_KEYS",      # undone at runtime: SQLITE_DBCONFIG_ENABLE_FKEY off (pragma foreign_keys)
    "ENABLE_API_ARMOR", "ENABLE_COLUMN_METADATA", "ENABLE_DBSTAT_VTAB", "ENABLE_FTS3", "ENABLE_FTS3_PARENTHESIS",
    "ENABLE_FTS5", "ENABLE_LOAD_EXTENSION", "ENABLE_MEMORY_MANAGEMENT", "ENABLE_RTREE", "ENABLE_STAT4", "HAVE_ISNAN",
    "MAX_EXPR_DEPTH=1000", "MAX_MMAP_SIZE=0x7fff0000", "MAX_WORKER_THREADS=8", "SOUNDEX", "USE_URI",
    "THREADSAFE=1", "MUTEX_PTHREADS",  # connections move between tokio threads
}
REQUIRED_COMPILE_OPTIONS = {"ENABLE_SESSION", "ENABLE_PREUPDATE_HOOK"}  # changesets for rebase/rollback

print(f"SQLite version: wa-sqlite {wasm['version']}, rusqlite bundled {native['version']} (not compared)")
diffs = 0
def fail(msg):
    global diffs
    diffs += 1
    print("DIFF", msg)

for key, allowed in (("pragmas", ALLOWED_PRAGMAS), ("probes", ALLOWED_PROBES)):
    for name in sorted(set(wasm[key]) | set(native[key])):
        if name not in allowed and wasm[key].get(name) != native[key].get(name):
            fail(f"{key}.{name}: wa-sqlite {wasm[key].get(name)!r}, native {native[key].get(name)!r}")
for key, allowed in (("modules", ALLOWED_MODULES), ("functions", EXTENSION_FUNCTIONS | RUSQLITE_FUNCTIONS)):
    unexpected = set(wasm[key]) ^ set(native[key])
    if unexpected - allowed:
        fail(f"{key} present on one side only: {sorted(unexpected - allowed)}")
options = lambda b: {o for o in b["compileOptions"] if not o.startswith("COMPILER=")}
for side, b in (("wa-sqlite", wasm), ("native", native)):
    if REQUIRED_COMPILE_OPTIONS - options(b):
        fail(f"{side} lacks required compile options {sorted(REQUIRED_COMPILE_OPTIONS - options(b))}")
unexpected = (options(wasm) ^ options(native)) - ALLOWED_COMPILE_OPTIONS
if unexpected:
    fail(f"compile options present on one side only: {sorted(unexpected)}")
print("OK: same behavior apart from the allow-list" if diffs == 0 else f"{diffs} difference(s)")
sys.exit(1 if diffs else 0)
PY
