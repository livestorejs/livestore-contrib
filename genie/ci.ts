/**
 * Shared CI check names used by workflow and repository rulesets.
 *
 * Keep these stable. The workflow implementation can evolve as packages and
 * examples are imported, but branch protection should point at semantic gates.
 */

export const requiredCIJobs = [
  'source-policy',
  'pr/minimal-dev',
  'pr/quality',
  'pr/types',
  'pr/packages',
  'pr/examples-build',
  'pr/node',
  'release-surface',
] as const
