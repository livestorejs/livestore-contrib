import type { ArtifactCatalogEntry } from './artifact-catalog.ts'
import { summarizeDurations, type TimingMetric } from './performance.ts'

export const compareRuns = (
  entries: ReadonlyArray<ArtifactCatalogEntry>,
  baseline: string,
  candidate: string,
  metric: TimingMetric,
) => {
  const groups = new Map<string, ArtifactCatalogEntry[]>()
  for (const entry of entries) {
    if (entry.sourceRevision !== baseline && entry.sourceRevision !== candidate) continue
    // Old catalogs without a workload fingerprint must not be matched by name alone.
    const key = entry.comparisonKey ?? `unknown:${entry.file}`
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const side = (revision: string) => {
        const runs = group.filter((entry) => entry.sourceRevision === revision)
        const passed = runs.filter((entry) => entry.status === 'passed')
        const durations = passed.flatMap((entry) =>
          entry.timings?.[metric] === undefined ? [] : [entry.timings[metric]!],
        )
        return { runs, passed: passed.length, stats: summarizeDurations(durations) }
      }
      const left = side(baseline)
      const right = side(candidate)
      const comparable =
        baseline !== candidate &&
        left.runs.length > 0 &&
        right.runs.length > 0 &&
        left.passed === left.runs.length &&
        right.passed === right.runs.length &&
        left.stats?.count === left.runs.length &&
        right.stats?.count === right.runs.length &&
        group.every((e) => e.benchmark?.complete !== false) &&
        new Set(group.map((e) => e.benchmark?.id ?? 'exploratory')).size === 1
      const delta =
        comparable && left.stats && right.stats && left.stats.median > 0
          ? (right.stats.median / left.stats.median - 1) * 100
          : undefined
      return { key, entry: group[0]!, baseline: left, candidate: right, delta }
    })
    .toSorted(
      (a, b) =>
        a.entry.scenarioId.localeCompare(b.entry.scenarioId) ||
        a.entry.profile.localeCompare(b.entry.profile) ||
        a.key.localeCompare(b.key),
    )
}
