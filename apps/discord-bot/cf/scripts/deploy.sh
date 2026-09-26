#!/usr/bin/env bash
set -e

approved=false
for arg in "$@"; do
  if [[ "$arg" == --yes ]]; then
    approved=true
    break
  fi
done

if [[ "$approved" != true && ( "${ALCHEMY_TUI:-}" != 1 || "${ALCHEMY_PLAIN:-}" == 1 || "${ALCHEMY_NO_TUI:-}" == 1 ) ]]; then
  printf '%s\n' 'cf:deploy requires explicit approval: pass --yes or set ALCHEMY_TUI=1 (without ALCHEMY_PLAIN=1 or ALCHEMY_NO_TUI=1).' >&2
  exit 2
fi

node --experimental-strip-types cf/src/deploy-preflight.ts
(cd cf && node --experimental-strip-types scripts/state-migrate.ts --verify-remote-authoritative)
alchemy deploy cf/alchemy.run.ts "$@"
