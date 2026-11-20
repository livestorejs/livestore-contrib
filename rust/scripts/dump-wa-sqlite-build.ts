// Dumps the SQLite build LiveStore's adapters load (wa-sqlite dist, non-FTS5 variant) as the parity fixture.
// Run from the contrib root: bun rust/scripts/dump-wa-sqlite-build.ts
import WaSqliteFactory from '../../repos/livestore/packages/@livestore/wa-sqlite/dist/wa-sqlite.node.mjs'
import * as WaSqlite from '../../repos/livestore/packages/@livestore/wa-sqlite/src/sqlite-api.js'
import { makeInMemoryDb } from '../../repos/livestore/packages/@livestore/sqlite-wasm/src/in-memory-vfs.ts'

const module = await WaSqliteFactory()
const sqlite3 = Object.assign(WaSqlite.Factory(module), { module })
// Same path as the node adapter's in-memory DB (also registers extension-functions.c).
const { dbPointer: db } = makeInMemoryDb(sqlite3)

const rows = (sql: string): unknown[][] => {
  const out: unknown[][] = []
  sqlite3.exec(db, sql, (row: unknown[]) => void out.push([...row]))
  return out
}
const scalar = (sql: string) => rows(sql)[0]?.[0]
const probe = (sql: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: scalar(sql) ?? null }
  } catch (e) {
    return { ok: false, error: String((e as Error).message) }
  }
}

const pragmas = [
  'foreign_keys', 'recursive_triggers', 'automatic_index', 'cache_size', 'page_size', 'journal_mode',
  'synchronous', 'temp_store', 'secure_delete', 'cell_size_check', 'defer_foreign_keys', 'trusted_schema',
  'legacy_alter_table', 'reverse_unordered_selects', 'case_sensitive_like', 'ignore_check_constraints',
  'query_only', 'auto_vacuum', 'encoding', 'busy_timeout', 'max_page_count', 'wal_autocheckpoint', 'threads',
  'hard_heap_limit', 'soft_heap_limit', 'mmap_size', 'locking_mode', 'cache_spill', 'analysis_limit',
]

const fixture = {
  source: 'packages/@livestore/wa-sqlite/dist/wa-sqlite.node.mjs',
  version: scalar('select sqlite_version()'),
  sourceId: scalar('select sqlite_source_id()'),
  compileOptions: rows('pragma compile_options').map((r) => r[0]),
  pragmas: Object.fromEntries(pragmas.map((p) => [p, scalar(`pragma ${p}`) ?? null])),
  modules: rows('select name from pragma_module_list order by name').map((r) => r[0]),
  functions: rows('select distinct name from pragma_function_list order by name').map((r) => r[0]),
  probes: {
    fts5: probe('create virtual table t_fts5 using fts5(a)'),
    rtree: probe('create virtual table t_rtree using rtree(id, x0, x1)'),
    dqsSelect: probe('select "x"'),
    likeBlob: probe(`select X'00' like '%'`),
    json: probe(`select json('{"a":1}')`),
    jsonb: probe(`select typeof(jsonb('{}'))`),
    dbstat: probe('select count(*) >= 0 from dbstat'),
    bytecode: probe(`select count(*) > 0 from bytecode('select 1')`),
    loadExtension: probe(`select load_extension('x')`),
  },
}

await Bun.write(
  new URL('../fixtures/sqlite/wa-sqlite.json', import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`,
)
console.log(fixture.version, fixture.sourceId, fixture.compileOptions.length, 'options')
