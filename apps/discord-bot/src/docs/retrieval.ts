import type { DocumentationSnapshot, DocumentationSource } from './domain.ts'

export interface RetrievalBounds {
  readonly maximumSources: number
  readonly maximumCharactersPerSource: number
  readonly maximumTotalCharacters: number
}

export const defaultRetrievalBounds: RetrievalBounds = {
  maximumSources: 8,
  maximumCharactersPerSource: 12_000,
  maximumTotalCharacters: 72_000,
}

const stopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'of',
  'the',
  'to',
  'what',
  'with',
])

const terms = (value: string) =>
  [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].filter((term) => !stopWords.has(term))

const occurrences = (haystack: string, needle: string) => {
  let count = 0
  let offset = 0
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

/** Deterministic local retrieval keeps the provider input bounded and reproducible. */
export const selectDocumentationSources = (
  snapshot: DocumentationSnapshot,
  query: string,
  bounds: RetrievalBounds = defaultRetrievalBounds,
): ReadonlyArray<DocumentationSource> => {
  const queryTerms = terms(query)
  const ranked = snapshot.sources
    .map((source, ordinal) => {
      const title = `${source.title} ${source.canonicalUrl}`.toLocaleLowerCase()
      const content = source.content.toLocaleLowerCase()
      const score = queryTerms.reduce(
        (total, term) => total + occurrences(title, term) * 20 + Math.min(occurrences(content, term), 10),
        0,
      )
      return { source, ordinal, score }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.ordinal - right.ordinal)

  const candidates =
    ranked.length > 0 ? ranked : snapshot.sources.slice(0, 1).map((source, ordinal) => ({ source, ordinal, score: 0 }))
  const selected: Array<DocumentationSource> = []
  let characters = 0
  for (const { source } of candidates) {
    if (selected.length >= bounds.maximumSources || characters >= bounds.maximumTotalCharacters) break
    const remaining = bounds.maximumTotalCharacters - characters
    const content = source.content.slice(0, Math.min(bounds.maximumCharactersPerSource, remaining))
    if (content.length === 0) continue
    selected.push({ ...source, content })
    characters += content.length
  }
  return selected
}
