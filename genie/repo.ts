/**
 * Contrib repository composition helpers.
 *
 * Core and effect-utils remain the source of truth for shared generator
 * helpers. Contrib imports core helpers through the materialized repo symlink.
 */

export * from '../repos/livestore/genie/repo.ts'

export const CONTRIB_REPO_NAME = 'livestore-contrib'
