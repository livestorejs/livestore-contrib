#!/usr/bin/env bash
# Regenerates crates/livestore-sqlite-sys/sqlite/ from the SQLite commit pinned in wa-sqlite's flake.nix,
# the same way wa-sqlite's Makefile does (`configure --enable-all && make sqlite3.c`).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
flake="$here/../repos/livestore/packages/@livestore/wa-sqlite/flake.nix"
commit="$(sed -n 's/.*sqliteCommit = "\(.*\)";/\1/p' "$flake")"
version="$(sed -n 's/.*sqliteVersion = "\(.*\)";/\1/p' "$flake")"
out="$here/crates/livestore-sqlite-sys/sqlite"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/src" "$work/build"
curl -LsSf "https://github.com/sqlite/sqlite/archive/$commit.tar.gz" | tar -xzf - -C "$work/src" --strip-components=1
[ "$(cat "$work/src/VERSION")" = "$version" ] || { echo "VERSION mismatch" >&2; exit 1; }
(cd "$work/build" && ../src/configure --enable-all >/dev/null && make sqlite3.c >/dev/null)

# wa-sqlite's Nix build edits the source tree (shebang patching), so mksourceid marks its source id
# with "alt1" (first 60 hash chars + "alt1"). Apply the same marker so sqlite_source_id() matches.
id="$(sed -n 's/^#define SQLITE_SOURCE_ID *"\(.*\)"$/\1/p' "$work/build/sqlite3.h")"
alt="${id:0:$((${#id} - 4))}alt1"
mkdir -p "$out"
for f in sqlite3.c sqlite3.h; do sed "s/$id/$alt/" "$work/build/$f" > "$out/$f"; done
cp "$work/build/sqlite3ext.h" "$out/"
echo "vendored SQLite $version ($alt)"
