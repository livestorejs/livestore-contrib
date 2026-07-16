/**
 * Enforcement checks for the contrib intent layer (`context/` VRS tree).
 *
 * Mirrors the core suite (`livestorejs/livestore`
 * `tests/package-common/src/intent-layer/intent-layer.test.ts`) adapted to the
 * `LSC.*` namespace, and adds the cross-repo half: a contrib `refines:` marker
 * may target a core `LS.*` ID, which is resolved against the megarepo-pinned
 * core intent layer at `repos/livestore/context/`.
 *
 * The logic lives here as pure functions so it can be run standalone (no
 * workspace install) via `../check.ts`, and equally wrapped in a Vitest lane
 * once `tests/intent-layer` is registered as a workspace package. `runChecks`
 * returns a map of check-name → violations; a caller fails on any non-empty.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface Options {
  /** Contrib repo root (contains `context/spec.md`). */
  repoRoot: string
  /**
   * Core intent-layer `context/` dir to resolve cross-repo `refines: LS.*`
   * against. Defaults to the megarepo-materialized core at
   * `<repoRoot>/repos/livestore/context`. When it is absent or does not carry
   * the intent layer (e.g. the core pin predates it), the cross-repo half is
   * skipped with a logged notice — the LSC-local checks still run.
   */
  coreContextDir?: string
  /** Sink for the skip notice (defaults to console.warn). */
  warn?: (message: string) => void
}

export interface CheckResult {
  violations: Record<string, string[]>
  crossRepoActive: boolean
}

const CONTRIB_ID = String.raw`LSC(?:\.[A-Z]+)*-(?:A|T|R|DQ)\d+`
const CORE_ID = String.raw`LS(?:\.[A-Z]+)*-(?:A|T|R|DQ)\d+`
const DEFINITION_RE = new RegExp(String.raw`^\s*-\s+\*\*(${CONTRIB_ID})[^*]*[:.]\*\*`)

const walkFiles = (dir: string): string[] =>
  fs.existsSync(dir) === false
    ? []
    : fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        return e.isDirectory() ? walkFiles(p) : e.isFile() ? [p] : []
      })

const walkDirs = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory() === false) return []
    const p = path.join(dir, e.name)
    return [p, ...walkDirs(p)]
  })

const namespaceOf = (id: string) => id.slice(0, id.lastIndexOf('-'))

/** Bolded, defined core IDs across a core `context/` tree (for cross-repo resolution). */
const coreDefinedIds = (coreContextDir: string): Set<string> => {
  const coreDefRe = new RegExp(String.raw`^\s*-\s+\*\*(${CORE_ID})[^*]*[:.]\*\*`)
  const ids = new Set<string>()
  for (const file of walkFiles(coreContextDir).filter((f) => f.endsWith('.md'))) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = coreDefRe.exec(line)
      if (m !== null) ids.add(m[1]!)
    }
  }
  return ids
}

/** Parse the `## ID Scheme` table of contrib `context/spec.md` → namespace → {dir, isRealization}. */
const parseNamespaceTable = (contextDir: string) => {
  const specText = fs.readFileSync(path.join(contextDir, 'spec.md'), 'utf8')
  const section = specText.split(/^## ID Scheme$/m)[1]?.split(/^## /m)[0]
  if (section === undefined) throw new Error('contrib context/spec.md: `## ID Scheme` section not found')
  const map = new Map<string, { dir: string; isRealization: boolean }>()
  for (const row of section.split('\n')) {
    if (row.trimStart().startsWith('|') === false) continue
    const cells = row.split('|').map((c) => c.trim())
    if (cells.length < 3) continue
    const namespaces = [...cells[1]!.matchAll(/`(LSC(?:\.[A-Z]+)*)-\*`/g)].map((m) => m[1]!)
    if (namespaces.length === 0) continue
    const firstPath = /`([\w./-]+\/)`/.exec(cells[2]!)?.[1] ?? ''
    namespaces.forEach((ns, i) => map.set(ns, { dir: firstPath, isRealization: i > 0 }))
  }
  return map
}

export const runChecks = (opts: Options): CheckResult => {
  const { repoRoot } = opts
  const warn = opts.warn ?? ((m) => console.warn(m))
  const contextDir = path.join(repoRoot, 'context')
  const coreContextDir = opts.coreContextDir ?? path.join(repoRoot, 'repos', 'livestore', 'context')
  const rel = (f: string) => path.relative(repoRoot, f)
  const mdFiles = walkFiles(contextDir).filter((f) => f.endsWith('.md'))

  const definitions = mdFiles.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => {
        const m = DEFINITION_RE.exec(line)
        return m === null ? [] : [{ id: m[1]!, namespace: namespaceOf(m[1]!), file, line: i + 1 }]
      }),
  )
  const definedIds = new Set(definitions.map((d) => d.id))

  // Cross-repo core ID set — guarded: absent/legacy core pin ⇒ skip, LSC checks still run.
  const coreIds = coreDefinedIds(coreContextDir)
  const crossRepoActive = coreIds.has('LS-R15') // stable root anchor of the core intent layer
  if (crossRepoActive === false) {
    warn(
      `[intent-layer] cross-repo refines resolution SKIPPED: core intent layer not found at ${coreContextDir} ` +
        `(pinned core rev predates it). LSC-local checks still enforced; the cross-repo half activates once ` +
        `contrib pins a core rev carrying context/ (post-#1406).`,
    )
  }

  const v: Record<string, string[]> = {}

  // 1. every LSC ID defined exactly once
  const byId = new Map<string, typeof definitions>()
  for (const d of definitions) byId.set(d.id, [...(byId.get(d.id) ?? []), d])
  v['unique ids'] = [...byId.values()]
    .filter((s) => s.length > 1)
    .map((s) => `${s[0]!.id} defined at ${s.map((x) => `${rel(x.file)}:${x.line}`).join(', ')}`)

  // 2. IDs live in the directory their namespace maps to (spec.md ID Scheme table)
  const table = parseNamespaceTable(contextDir)
  v['namespace↔dir'] = definitions.flatMap((d) => {
    const entry = table.get(d.namespace)
    if (entry === undefined) return [`${rel(d.file)}:${d.line} — namespace ${d.namespace} (${d.id}) missing from ID table`]
    const fileDirRel = path.relative(contextDir, path.dirname(d.file))
    const nodeDir = entry.dir.replace(/\/$/, '')
    const inNode = entry.isRealization
      ? fileDirRel.startsWith(nodeDir === '' ? '' : `${nodeDir}${path.sep}`)
      : fileDirRel === nodeDir
    return inNode ? [] : [`${rel(d.file)}:${d.line} — ${d.id} expected under context/${entry.dir}`]
  })

  // 3. refines targets resolve — LSC.* locally, LS.* cross-repo (guarded)
  v['refines'] = mdFiles.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        [...line.matchAll(/`refines: ([^`]+)`/g)].flatMap((m) =>
          m[1]!
            .split(',')
            .map((t) => t.trim())
            .flatMap((token) => {
              if (/^<[^>]+>$/.test(token)) return []
              const isContrib = new RegExp(`^${CONTRIB_ID}$`).test(token)
              const isCore = new RegExp(`^${CORE_ID}$`).test(token)
              if (isContrib) {
                return definedIds.has(token) ? [] : [`${rel(file)}:${i + 1} — refines target ${token} not defined in contrib`]
              }
              if (isCore) {
                if (crossRepoActive === false) return [] // guarded
                return coreIds.has(token) ? [] : [`${rel(file)}:${i + 1} — cross-repo refines target ${token} not in core intent layer`]
              }
              return [`${rel(file)}:${i + 1} — malformed refines target ${JSON.stringify(token)}`]
            }),
        ),
      ),
  )

  // 4. relative links resolve (http/mailto/anchor skipped)
  v['links'] = mdFiles.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        [...line.matchAll(/\[[^\]]*\]\(([^()\s]+)\)/g)].flatMap((m) => {
          const target = m[1]!
          if (/^(https?:|mailto:|#)/.test(target)) return []
          const targetPath = path.resolve(path.dirname(file), target.split('#')[0]!)
          return fs.existsSync(targetPath) ? [] : [`${rel(file)}:${i + 1} — broken link ${target}`]
        }),
      ),
  )

  // 5. every spec.md has a valid ## Status
  v['status'] = mdFiles
    .filter((f) => path.basename(f) === 'spec.md')
    .flatMap((file) => {
      const status = fs
        .readFileSync(file, 'utf8')
        .split(/^## Status$/m)[1]
        ?.split(/^## /m)[0]
        ?.trim()
        ?.split(/[\s.]/)[0]
      return status !== undefined && ['Draft', 'Active', 'Stable'].includes(status)
        ? []
        : [`${rel(file)} — missing or invalid ## Status (got ${JSON.stringify(status)})`]
    })

  // 6. no empty companion dirs
  v['no empty dirs'] = walkDirs(contextDir)
    .filter((dir) => walkFiles(dir).length === 0)
    .map((d) => rel(d))

  // 7. decision records well-formed, no committed .proposed/
  v['decisions'] = walkDirs(contextDir)
    .filter((d) => path.basename(d) === '.decisions')
    .flatMap((dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) return e.name === '.proposed' && walkFiles(p).length > 0 ? [`${rel(p)} — committed .proposed/ records`] : []
        const out: string[] = []
        if (/^\d{4}-[a-z0-9-]+\.md$/.test(e.name) === false) out.push(`${rel(p)} — decision filename must match NNNN-slug.md`)
        if (/^Status: /m.test(fs.readFileSync(p, 'utf8')) === false) out.push(`${rel(p)} — decision record missing a Status: line`)
        return out
      }),
    )

  // 8. maturity vocabulary (only `experimental`)
  v['maturity'] = mdFiles.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        [...line.matchAll(/\*\*Maturity: ([a-zA-Z-]+)/g)].flatMap((m) =>
          ['experimental'].includes(m[1]!) ? [] : [`${rel(file)}:${i + 1} — unknown maturity ${JSON.stringify(m[1])}`],
        ),
      ),
  )

  return { violations: v, crossRepoActive }
}
