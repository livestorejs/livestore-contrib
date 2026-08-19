/**
 * Contrib repository composition helpers.
 *
 * Core and effect-utils remain the source of truth for shared generator
 * helpers. Contrib imports core helpers through the materialized repo symlink.
 * Package-local helpers below intentionally override the core exports with
 * contrib repository identity, so imported package manifests can keep using
 * `../../../genie/repo.ts`.
 */

import { jsonArtifact } from '../repos/effect-utils/packages/@overeng/genie/src/runtime/json-artifact/mod.ts'
// Imported straight from effect-utils rather than through core's re-export: contrib pins a core
// revision that predates this step, so routing it through core would break generation here.
import { prepareCiScriptsStep } from '../repos/effect-utils/genie/ci-workflow.ts'
import {
  applyMegarepoLockStep,
  checkoutStep,
  installNixStep,
  livestorePackageDefaults as coreLivestorePackageDefaults,
  pnpmStateSetupStep,
  preparePinnedDevenvStep,
  restorePnpmStateStep,
  type PnpmPackageClosureConfig,
  utilsEffectPeerDeps,
  validateNixStoreStep,
  type WorkspaceIdentity,
} from '../repos/livestore/genie/repo.ts'
import { catalog as contribCatalog, packageJson as contribPackageJson } from './external.ts'

/**
 * Re-exports core's helpers for convenience — but note the hazard before relying on it.
 *
 * Core is composed here at a pinned revision, and core resolves effect-utils through *its own* lock.
 * So a symbol that reaches this repo via core carries whatever effect-utils revision core's pin
 * happened to hold, not the one this repo pins. When core's pin is older, the value is silently stale:
 * sometimes that fails loudly as a missing export, and sometimes it succeeds and produces subtly wrong
 * generated output.
 *
 * Anything that must track this repo's own effect-utils pin should therefore be imported from
 * `../repos/effect-utils/...` directly, as the PR snapshot factory and the oxfmt ignore patterns are.
 */
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

/**
 * Override core's `effectDevDeps` so contrib-owned packages resolve Effect
 * dev dependencies against contrib's catalog (`4.0.0-beta.98`) instead of core's
 * (`4.0.0-beta.97`). This explicit named export shadows the `export *` re-export
 * from core's repo helpers. `getUtilsPeerDeps` intentionally stays on core's
 * `^4.0.0-beta.97` peer ranges (which beta.98 satisfies).
 */
export const effectDevDeps = (...additionalDeps: Parameters<typeof contribCatalog.pick>) =>
  contribCatalog.pick(...utilsEffectPeerDeps, ...additionalDeps)

export const githubRepositorySettings = <const TSettings extends Record<string, unknown>>(settings: TSettings) =>
  jsonArtifact({ data: settings })

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
  // Copy CI helper scripts (e.g. the nix-gc-race retry wrapper) into the prepared scripts dir before
  // any retry-wrapped command runs, and before an alternate checkout can replace the workspace.
  // Required by the genie CI workflow validator.
  prepareCiScriptsStep,
  installNixStep({
    extraConf:
      'extra-substituters = https://cache.nixos.org\nextra-trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
  }),
  applyMegarepoLockStep(),
  preparePinnedDevenvStep,
  pnpmStateSetupStep,
  restorePnpmStateStep({ keyPrefix: 'livestore-contrib-pnpm-state-v1' }),
  validateNixStoreStep,
] as const

export const livestoreContribSetupSteps = [checkoutStep(), ...livestoreContribSetupStepsAfterCheckout] as const
