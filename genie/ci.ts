/**
 * Shared CI check names used by workflow and repository rulesets.
 *
 * Keep these stable. The workflow implementation can evolve as packages and
 * examples are imported, but branch protection should point at semantic gates.
 */

export const requiredCIJobs = ['source-policy', 'check-all', 'release-surface'] as const
