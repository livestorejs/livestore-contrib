/**
 * Standalone entry for the contrib intent-layer enforcement checks.
 *
 * Runnable with no workspace install (only `bun`/`node` + the fs):
 *   bun tests/intent-layer/check.ts
 *
 * Resolves the contrib repo root by walking up to `context/spec.md`, runs the
 * checks in `src/checks.ts`, prints any violations, and exits non-zero on
 * failure. The cross-repo `refines: LS.*` half resolves against the
 * megarepo-pinned core at `repos/livestore/context/`; override with
 * `LIVESTORE_CORE_CONTEXT_DIR` (e.g. to point at a local core checkout).
 */
import fs from 'node:fs'
import path from 'node:path'

import { runChecks } from './src/checks.ts'

const findRepoRoot = () => {
  let dir = import.meta.dirname
  while (fs.existsSync(path.join(dir, 'context', 'spec.md')) === false) {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('contrib repo root with context/spec.md not found')
    dir = parent
  }
  return dir
}

const { violations, crossRepoActive } = runChecks({
  repoRoot: findRepoRoot(),
  coreContextDir: process.env.LIVESTORE_CORE_CONTEXT_DIR,
})

let total = 0
for (const [name, vs] of Object.entries(violations)) {
  total += vs.length
  if (vs.length > 0) {
    console.error(`✖ ${name} (${vs.length})`)
    for (const v of vs) console.error(`    ${v}`)
  }
}
console.error(
  `\nintent-layer checks: ${total === 0 ? 'PASS' : 'FAIL'} (${total} violations)` +
    ` · cross-repo ${crossRepoActive ? 'ACTIVE' : 'skipped (core pin predates intent layer)'}`,
)
process.exit(total === 0 ? 0 : 1)
