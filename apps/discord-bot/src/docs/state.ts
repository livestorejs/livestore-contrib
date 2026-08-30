import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Effect, Schema } from 'effect'

import type { DocsTelemetryEvent } from './domain.ts'
import { type DocsQuotaSample, type DocsStateStore, StateFile } from './state-schema.ts'

// The schemas and store contract live in the node-free `state-schema.ts`;
// re-exported so every existing importer (and the docs barrel) is unchanged.
export * from './state-schema.ts'

const queues = new Map<string, Promise<void>>()
const serialized = <A>(path: string, operation: () => Promise<A>): Promise<A> => {
  const previous = queues.get(path) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  queues.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** Content-free diagnostic fallback; OTLP export is installed by the runtime when configured. */
export const makeFileDocsTelemetry = (stateDirectory: string) => ({
  emit: (event: DocsTelemetryEvent) =>
    Effect.logDebug('docs telemetry').pipe(Effect.annotateLogs({ ...event, diagnosticDirectory: stateDirectory })),
})

/**
 * Small content-free state file. It stores no query, answer, URL, username, or
 * raw Discord ID and prunes every record after 24 hours before each write/read.
 */
export const makeFileDocsStateStore = (stateDirectory: string, now: () => number = Date.now): DocsStateStore => {
  const path = join(stateDirectory, 'docs-state.json')
  const load = async (): Promise<StateFile> => {
    try {
      return Schema.decodeUnknownSync(StateFile)(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return { version: 1, provenance: [], quota: [], monthly: [] }
      throw error
    }
  }
  const persist = async (value: StateFile) => {
    await mkdir(dirname(path), { recursive: true })
    // A unique temporary name prevents concurrent writers from replacing one another's temp file.
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }
  const prune = (value: StateFile, at: number): StateFile => {
    const cutoff = at - 24 * 60 * 60 * 1_000
    return {
      version: 1,
      provenance: value.provenance.filter((entry) => entry.atMillis > cutoff),
      quota: value.quota.filter((entry) => entry.atMillis > cutoff),
      monthly: value.monthly.filter((entry) => entry.atMillis > at - 366 * 24 * 60 * 60 * 1_000),
    }
  }
  return {
    record: (input) =>
      Effect.tryPromise(() =>
        serialized(path, async () => {
          const at = now()
          const value = prune(await load(), at)
          await persist({
            version: 1,
            provenance: [...value.provenance, input.provenance],
            quota: [...value.quota, input.quota],
            monthly: value.monthly,
          })
        }),
      ),
    recent: (nowMillis) => Effect.tryPromise(() => serialized(path, async () => prune(await load(), nowMillis))),
    monthlySpent: (nowMillis) =>
      Effect.tryPromise(() =>
        serialized(path, async () => {
          const month = new Date(nowMillis).toISOString().slice(0, 7)
          return (await load()).monthly
            .filter(
              (entry) => entry.status !== 'cancelled' && new Date(entry.atMillis).toISOString().slice(0, 7) === month,
            )
            .reduce((sum, entry) => sum + entry.costUsdMicros, 0)
        }),
      ),
    reserveMonthly: (input) =>
      Effect.tryPromise(() =>
        serialized(path, async () => {
          const value = prune(await load(), input.atMillis)
          const month = new Date(input.atMillis).toISOString().slice(0, 7)
          const spent = value.monthly
            .filter(
              (entry) => entry.status !== 'cancelled' && new Date(entry.atMillis).toISOString().slice(0, 7) === month,
            )
            .reduce((sum, entry) => sum + entry.costUsdMicros, 0)
          if (spent + input.costUsdMicros > input.ceilingUsdMicros) return { _tag: 'Denied' }
          const id = randomUUID()
          await persist({
            ...value,
            monthly: [
              ...value.monthly,
              { id, atMillis: input.atMillis, costUsdMicros: input.costUsdMicros, status: 'reserved' },
            ],
          })
          return { _tag: 'Reserved', id }
        }),
      ),
    settleMonthly: (input) =>
      Effect.tryPromise(() =>
        serialized(path, async () => {
          const value = prune(await load(), now())
          const index = value.monthly.findIndex((entry) => entry.id === input.id)
          if (index < 0) throw new Error('Unknown monthly reservation')
          const entry = value.monthly[index]
          if (entry === undefined) throw new Error('Unknown monthly reservation')
          if (entry.status !== 'reserved') return
          const monthly = [...value.monthly]
          monthly[index] =
            input.outcome === 'cancel'
              ? { ...entry, status: 'cancelled' }
              : { ...entry, status: 'charged', costUsdMicros: input.costUsdMicros ?? entry.costUsdMicros }
          await persist({ ...value, monthly })
        }),
      ),
  }
}
