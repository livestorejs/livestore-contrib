import { Schema } from '@livestore/utils/effect'

import { ScenarioRunArtifact } from '../model.ts'

export interface ArtifactCatalog {
  readonly version: 3
  readonly entries: ReadonlyArray<{
    readonly findingId?: string
    readonly file: string
    readonly label: string
    readonly applicationEventCount: number
    readonly traceRecordCount: number
    readonly status?: 'passed' | 'failed'
  }>
}

export const decodeArtifactJson = (input: string): ScenarioRunArtifact =>
  Schema.decodeUnknownSync(Schema.fromJsonString(ScenarioRunArtifact))(input)

export const readArtifactFile = async (file: File): Promise<string> =>
  file.name.endsWith('.gz') === true ? decompressGzip(await file.arrayBuffer()) : file.text()

export const fetchArtifactJson = async (file: string): Promise<string> => {
  const response = await fetch(`/${encodeURIComponent(file)}`)
  if (response.ok === false) throw new Error(`Could not load saved artifact ${file}.`)
  if (file.endsWith('.gz') === false) return response.text()

  const body = await response.arrayBuffer()
  // Dev/static servers may expose .gz files as HTTP content-encoded resources. Browsers
  // transparently decode those responses, so only run DecompressionStream when gzip magic remains.
  return hasGzipHeader(body) === true ? decompressGzip(body) : new TextDecoder().decode(body)
}

export const fetchArtifactCatalog = async (): Promise<ArtifactCatalog> => {
  const response = await fetch('/catalog.json')
  if (response.ok === false) throw new Error('Run a scenario to generate the saved-run catalog.')
  return response.json() as Promise<ArtifactCatalog>
}

const decompressGzip = async (input: ArrayBuffer): Promise<string> => {
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

const hasGzipHeader = (input: ArrayBuffer): boolean => {
  const header = new Uint8Array(input, 0, Math.min(input.byteLength, 2))
  return header[0] === 0x1f && header[1] === 0x8b
}
