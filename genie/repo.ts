/**
 * Contrib repository composition helpers.
 *
 * Core and effect-utils remain the source of truth for shared generator
 * helpers. Contrib imports core helpers through the materialized repo symlink.
 * Package-local helpers below intentionally override the core exports with
 * contrib repository identity, so imported package manifests can keep using
 * `../../../genie/repo.ts`.
 */

import {
  livestorePackageDefaults as coreLivestorePackageDefaults,
  type PnpmPackageClosureConfig,
  type WorkspaceIdentity,
} from '../repos/livestore/genie/repo.ts'
import { catalog as contribCatalog } from './external.ts'

export * from '../repos/livestore/genie/repo.ts'

export const CONTRIB_REPO_NAME = 'livestore-contrib'

export const workspaceMember = (
  memberPath: string,
  pnpmPackageClosure: PnpmPackageClosureConfig = {},
): WorkspaceIdentity => ({
  repoName: CONTRIB_REPO_NAME,
  memberPath,
  pnpmPackageClosure,
})

export const catalog = contribCatalog

export const livestorePackageDefaults = {
  ...coreLivestorePackageDefaults,
  repository: { type: 'git', url: 'git+https://github.com/livestorejs/livestore-contrib.git' },
}
