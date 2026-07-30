import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { Schema } from '@livestore/utils/effect'

import {
  buildArtifactCatalogFromEntries,
  makeArtifactCatalogEntry,
  type ArtifactCatalogEntry,
} from './artifact-catalog.ts'
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
      const artifact = Schema.decodeUnknownSync(Schema.fromJsonString(ScenarioRunArtifact))(artifactJson)
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

  const catalog = buildArtifactCatalogFromEntries(catalogEntries)
  await fs.writeFile(path.join(artifactDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
}
