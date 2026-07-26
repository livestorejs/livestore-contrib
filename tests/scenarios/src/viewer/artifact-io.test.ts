import { afterEach, describe, expect, test, vi } from 'vitest'

import { fetchArtifactJson } from './artifact-io.ts'

describe('fetchArtifactJson', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('accepts a gzip response that the browser has already decoded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(artifactJson)),
    )

    await expect(fetchArtifactJson('reference.json.gz')).resolves.toBe(artifactJson)
  })

  test('decompresses gzip bytes when the server does not content-decode them', async () => {
    const compressed = await gzip(artifactJson)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(compressed)),
    )

    await expect(fetchArtifactJson('reference.json.gz')).resolves.toBe(artifactJson)
  })
})

const artifactJson = '{"artifactVersion":4}'

const gzip = async (input: string): Promise<ArrayBuffer> => {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}
