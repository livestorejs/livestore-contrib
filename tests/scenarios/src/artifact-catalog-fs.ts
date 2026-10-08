import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { Schema } from '@livestore/utils/effect'

import {
  buildArtifactCatalogFromEntries,
  makeArtifactCatalogEntry,
  type ArtifactCatalogEntry,
} from './artifact-catalog.ts'
import type { BenchmarkManifest } from './benchmark-model.ts'
import { ScenarioRunArtifact } from './model.ts'

export const writeArtifactCatalog = async (artifactDirectory: string): Promise<void> => {
  const catalogEntries: ArtifactCatalogEntry[] = []
  const artifactFiles = (await fs.readdir(artifactDirectory, { withFileTypes: true })).filter(
    (entry) =>
      entry.isFile() &&
      (entry.name.endsWith('.json') || entry.name.endsWith('.json.gz')) &&
      entry.name !== 'catalog.json',
  )

  for (const entry of artifactFiles) {
    try {
      const fileData = await fs.readFile(path.join(artifactDirectory, entry.name))
      const artifactJson =
        entry.name.endsWith('.gz') === true ? gunzipSync(fileData).toString('utf8') : fileData.toString('utf8')
      const artifact = Schema.decodeSync(Schema.fromJsonString(ScenarioRunArtifact))(artifactJson)
      catalogEntries.push(
        makeArtifactCatalogEntry({
          file: entry.name,
          artifact,
          reference: entry.name.startsWith('reference-'),
        }),
      )
    } catch {
      // A malformed or partial artifact must not make the remaining saved runs unavailable.
    }
  }

  const campaigns: BenchmarkManifest[] = []
  const campaignRoot = path.join(artifactDirectory, 'benchmarks')
  const directories = await fs.readdir(campaignRoot, { withFileTypes: true }).catch(() => [])
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(campaignRoot, directory.name, 'manifest.json'), 'utf8'),
      ) as BenchmarkManifest
      if (
        manifest.version !== 1 ||
        manifest.id !== directory.name ||
        typeof manifest.startedAt !== 'string' ||
        typeof manifest.baseline !== 'string' ||
        typeof manifest.candidate !== 'string' ||
        typeof manifest.environment !== 'object' ||
        manifest.environment === null ||
        !Array.isArray(manifest.samples) ||
        !['running', 'complete', 'interrupted'].includes(manifest.status)
      )
        continue
      const campaignEntries: ArtifactCatalogEntry[] = []
      for (const sample of manifest.samples) {
        if (sample.phase !== 'measured') continue
        if (path.basename(sample.file) !== sample.file || !['baseline', 'candidate'].includes(sample.role))
          throw new Error('Invalid sample')
        const file = `benchmarks/${directory.name}/${sample.file}`
        const artifact = Schema.decodeSync(Schema.fromJsonString(ScenarioRunArtifact))(
          await fs.readFile(path.join(artifactDirectory, file), 'utf8'),
        )
        if (artifact.descriptor.sourceRevision !== manifest[sample.role]) throw new Error('Sample revision mismatch')
        const entry = makeArtifactCatalogEntry({ file, artifact, reference: false })
        campaignEntries.push({
          ...entry,
          label: `${sample.role.toUpperCase()} · ${entry.label} · sample ${sample.iteration}`,
          benchmark: {
            id: manifest.id,
            role: sample.role,
            iteration: sample.iteration,
            complete: manifest.status === 'complete',
          },
        })
      }
      campaigns.push(manifest)
      catalogEntries.push(...campaignEntries)
    } catch {
      // A malformed campaign cannot contribute misleading partial comparison statistics.
    }
  }
  const catalog = {
    ...buildArtifactCatalogFromEntries(catalogEntries),
    campaigns: campaigns.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)),
  }
  await fs.writeFile(path.join(artifactDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
}
