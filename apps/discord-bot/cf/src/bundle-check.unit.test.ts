import { expect, it } from 'vitest'

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const workerEntry = resolve(import.meta.dirname, './worker.ts')

/** Recursively collects module specifiers from static + dynamic `import`/`from` clauses. */
const collectSpecifiers = (file: string, seen: Set<string>): string[] => {
  if (seen.has(file)) return []
  seen.add(file)
  const source = readFileSync(file, 'utf8')
  const specifiers = new Set<string>()
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1] ?? '')
    }
  }

  // Relative imports inside the worker graph are followed; bare specifiers
  // stop here (package internals are not part of the worker's own code).
  for (const specifier of specifiers) {
    if (specifier.startsWith('.') === false) continue
    const resolved = specifier.endsWith('.ts') ? join(dirname(file), specifier) : `${join(dirname(file), specifier)}.ts`
    collectSpecifiers(resolved, seen)
  }
  return [...specifiers]
}

it('the worker dependency graph contains no node: builtins and no test fakes', () => {
  const reachable = collectSpecifiers(workerEntry, new Set())
  expect(reachable.length).toBeGreaterThan(0)

  const nodeBuiltins = reachable.filter((specifier) => specifier.startsWith('node:'))
  expect(nodeBuiltins).toEqual([])

  const fakeReachable = reachable.some((specifier) => specifier.includes('fake-do-storage'))
  expect(fakeReachable).toBe(false)
})

/**
 * The source recrawl cannot see node builtins that bare specifiers reach
 * inside package internals, nor template-literal dynamic imports. After a
 * rolldown bundle exists (dist/), scan the emitted worker source itself —
 * the authoritative artifact. Skipped when no build is present so plain
 * `vitest run` stays green without a deploy.
 *
 * `nodejs_compat` must stay OFF in cf/src/worker.ts (compatibility.flags);
 * this scan is what makes turning it on unnecessary rather than tempting.
 */
it('the bundled dist output contains no node: builtins (when a build exists)', () => {
  const distDir = resolve(import.meta.dirname, '../dist')
  if (existsSync(distDir) === false) return

  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.js')) {
        const matches = readFileSync(full, 'utf8').match(/node:[a-z]+\//g)
        if (matches !== null) offenders.push(`${full}: ${[...new Set(matches)].join(', ')}`)
      }
    }
  }
  walk(distDir)
  expect(offenders).toEqual([])
})
