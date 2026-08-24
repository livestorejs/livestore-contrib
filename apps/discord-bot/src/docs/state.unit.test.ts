import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeFileDocsStateStore } from './state.ts'

describe('docs state', () => {
  it('persists content-free provenance and expires it after 24 hours', async () => {
    const root = await mkdtemp(join(tmpdir(), 'livestore-docs-state-'))
    try {
      const store = makeFileDocsStateStore(root, () => 2_000_000)
      await Effect.runPromise(
        store.record({
          provenance: {
            correlation: 'a'.repeat(64),
            atMillis: 2_000_000,
            corpusDigest: 'sha256:test',
            engineConfiguration: 'luna',
            sourceCount: 1,
            inputTokens: 2,
            outputTokens: 3,
            estimatedCostUsdMicros: 4,
          },
          quota: {
            principal: 'b'.repeat(64),
            atMillis: 2_000_000,
            inputTokens: 2,
            outputTokens: 3,
            costUsdMicros: 4,
          },
        }),
      )
      const recent = await Effect.runPromise(store.recent(2_000_000))
      expect(recent.provenance).toHaveLength(1)
      // Monthly accounting is reservation-owned; provenance recording alone never charges quota.
      expect(await Effect.runPromise(store.monthlySpent(2_000_000))).toBe(0)
      const restarted = makeFileDocsStateStore(root, () => 2_000_000)
      expect(await Effect.runPromise(restarted.monthlySpent(2_000_000))).toBe(0)
      expect(JSON.stringify(await readFile(join(root, 'docs-state.json'), 'utf8'))).not.toContain('Question')
      expect((await Effect.runPromise(store.recent(2_000_000 + 24 * 60 * 60 * 1_000 + 1))).provenance).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent reservations and settles conservatively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'livestore-docs-state-race-'))
    try {
      const store = makeFileDocsStateStore(root, () => 2_000_000)
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          Effect.runPromise(store.reserveMonthly({ atMillis: 2_000_000, costUsdMicros: 4, ceilingUsdMicros: 12 })),
        ),
      )
      expect(results.filter((result) => result._tag === 'Reserved')).toHaveLength(3)
      const reserved = results.filter(
        (result): result is { readonly _tag: 'Reserved'; readonly id: string } => result._tag === 'Reserved',
      )
      await Effect.runPromise(store.settleMonthly({ id: reserved[0]!.id, outcome: 'charge', costUsdMicros: 1 }))
      await Effect.runPromise(store.settleMonthly({ id: reserved[1]!.id, outcome: 'charge' }))
      await Effect.runPromise(store.settleMonthly({ id: reserved[2]!.id, outcome: 'cancel' }))
      expect(await Effect.runPromise(store.monthlySpent(2_000_000))).toBe(5)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed on corrupted state and survives restart/month boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'livestore-docs-state-corrupt-'))
    try {
      await writeFile(join(root, 'docs-state.json'), 'not-json')
      const corrupt = makeFileDocsStateStore(root, () => Date.UTC(2026, 1, 1))
      await expect(Effect.runPromise(corrupt.monthlySpent(Date.UTC(2026, 1, 1)))).rejects.toBeDefined()
      await rm(join(root, 'docs-state.json'))
      const store = makeFileDocsStateStore(root, () => Date.UTC(2026, 1, 1))
      const reservation = await Effect.runPromise(
        store.reserveMonthly({
          atMillis: Date.UTC(2026, 1, 1),
          costUsdMicros: 7,
          ceilingUsdMicros: 7,
        }),
      )
      expect(reservation._tag).toBe('Reserved')
      const restarted = makeFileDocsStateStore(root, () => Date.UTC(2026, 2, 1))
      expect(await Effect.runPromise(restarted.monthlySpent(Date.UTC(2026, 2, 1)))).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
