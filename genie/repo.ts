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
  applyMegarepoLockStep,
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  installNixStep,
  livestorePackageDefaults as coreLivestorePackageDefaults,
  pnpmStateSetupStep,
  preparePinnedDevenvStep,
  restorePnpmStateStep,
  type PnpmPackageClosureConfig,
  validateNixStoreStep,
  type WorkspaceIdentity,
} from '../repos/livestore/genie/repo.ts'
import { catalog as contribCatalog, packageJson as contribPackageJson } from './external.ts'

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

export const packageJson = contribPackageJson

export const livestorePackageDefaults = {
  ...coreLivestorePackageDefaults,
  repository: { type: 'git', url: 'git+https://github.com/livestorejs/livestore-contrib.git' },
}

export const refs = {
  adapterCloudflare: { path: '../../../repos/livestore/packages/@livestore/adapter-cloudflare' },
  adapterExpo: { path: '../adapter-expo' },
  adapterNode: { path: '../adapter-node' },
  adapterWeb: { path: '../../../repos/livestore/packages/@livestore/adapter-web' },
  cli: { path: '../cli' },
  common: { path: '../../../repos/livestore/packages/@livestore/common' },
  commonCf: { path: '../../../repos/livestore/packages/@livestore/common-cf' },
  devtoolsExpo: { path: '../devtools-expo' },
  effectPlaywright: { path: '../../../repos/livestore/packages/@livestore/effect-playwright' },
  frameworkToolkit: { path: '../../../repos/livestore/packages/@livestore/framework-toolkit' },
  graphql: { path: '../graphql' },
  livestore: { path: '../../../repos/livestore/packages/@livestore/livestore' },
  peerDeps: { path: '../../../repos/livestore/packages/@livestore/peer-deps' },
  react: { path: '../../../repos/livestore/packages/@livestore/react' },
  solid: { path: '../solid' },
  sqliteWasm: { path: '../../../repos/livestore/packages/@livestore/sqlite-wasm' },
  svelte: { path: '../svelte' },
  syncCf: { path: '../../../repos/livestore/packages/@livestore/sync-cf' },
  syncElectric: { path: '../sync-electric' },
  syncS2: { path: '../sync-s2' },
  utils: { path: '../../../repos/livestore/packages/@livestore/utils' },
  utilsDev: { path: '../../../repos/livestore/packages/@livestore/utils-dev' },
  waSqlite: { path: '../../../repos/livestore/packages/@livestore/wa-sqlite' },
  webmesh: { path: '../../../repos/livestore/packages/@livestore/webmesh' },
} as const

export const livestoreContribSetupStepsAfterCheckout = [
  installNixStep({
    extraConf:
      'extra-substituters = https://cache.nixos.org\nextra-trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
  }),
  cachixCliBuildStep,
  (() => {
    const base = cachixStep({ name: 'livestore-contrib', authToken: '${{ env.CACHIX_AUTH_TOKEN }}' })
    return { ...base, with: { ...base.with, skipPush: true } }
  })(),
  applyMegarepoLockStep(),
  preparePinnedDevenvStep,
  pnpmStateSetupStep,
  restorePnpmStateStep({ keyPrefix: 'livestore-contrib-pnpm-state-v1' }),
  validateNixStoreStep,
] as const

export const livestoreContribSetupSteps = [checkoutStep(), ...livestoreContribSetupStepsAfterCheckout] as const
