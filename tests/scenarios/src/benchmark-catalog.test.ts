import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { expect, it } from 'vitest'

import { writeArtifactCatalog } from './artifact-catalog-fs.ts'

it('indexes only measured campaign samples and preserves incomplete-campaign status', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-benchmark-'))
  try {
    const artifact = JSON.parse(
      gunzipSync(
        await fs.readFile(
          path.join(import.meta.dirname, '../artifacts/reference-offline-writer-recovery-browser.json.gz'),
        ),
      ).toString(),
    )
    const campaign = path.join(dir, 'benchmarks', 'test')
    await fs.mkdir(campaign, { recursive: true })
    const manifest = {
      version: 1,
      id: 'test',
      startedAt: '2026-01-01',
      status: 'running',
      baseline: artifact.descriptor.sourceRevision,
      candidate: 'other',
      environment: {},
      samples: [
        { file: 'warmup.json', phase: 'warmup', role: 'baseline', iteration: 1 },
        { file: 'measured.json', phase: 'measured', role: 'baseline', iteration: 1 },
      ],
    }
    await fs.writeFile(path.join(campaign, 'manifest.json'), JSON.stringify(manifest))
    await fs.writeFile(path.join(campaign, 'measured.json'), JSON.stringify(artifact))
    await fs.writeFile(path.join(campaign, 'warmup.json'), JSON.stringify(artifact))
    await writeArtifactCatalog(dir)
    let catalog = JSON.parse(await fs.readFile(path.join(dir, 'catalog.json'), 'utf8'))
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]).toMatchObject({
      file: 'benchmarks/test/measured.json',
      benchmark: { complete: false, iteration: 1, role: 'baseline' },
    })
    expect(catalog.entries[0].timings.runMs).toBeGreaterThan(0)
    await fs.writeFile(path.join(campaign, 'manifest.json'), JSON.stringify({ ...manifest, status: 'complete' }))
    await writeArtifactCatalog(dir)
    catalog = JSON.parse(await fs.readFile(path.join(dir, 'catalog.json'), 'utf8'))
    expect(catalog.entries[0].benchmark.complete).toBe(true)
    // Missing measured evidence must not silently reduce the sample count.
    await fs.unlink(path.join(campaign, 'measured.json'))
    await writeArtifactCatalog(dir)
    catalog = JSON.parse(await fs.readFile(path.join(dir, 'catalog.json'), 'utf8'))
    expect(catalog.entries).toHaveLength(0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
