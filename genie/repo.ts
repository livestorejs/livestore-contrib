/**
 * Contrib repository composition helpers.
 *
 * Core and effect-utils remain the source of truth for shared generator
 * helpers. Contrib imports core helpers through the materialized repo symlink.
 * Package-local helpers below intentionally override the core exports with
 * contrib repository identity, so imported package manifests can keep using
 * `../../../genie/repo.ts`.
 */

import { preparedCiRuntimeScriptsDir } from '../repos/effect-utils/genie/ci-workflow.ts'
import { jsonArtifact } from '../repos/effect-utils/packages/@overeng/genie/src/runtime/json-artifact/mod.ts'
import {
  applyMegarepoLockStep,
  checkoutStep,
  installNixStep,
  livestorePackageDefaults as coreLivestorePackageDefaults,
  pnpmStateSetupStep,
  preparePinnedDevenvStep,
  restorePnpmStateStep,
  type PnpmPackageClosureConfig,
  validateNixStoreStep,
  utilsEffectPeerDeps,
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

/** Resolve contrib-owned Effect development and peer dependencies from contrib's rc.111 catalog. */
export const effectDevDeps = (...additionalDeps: Parameters<typeof contribCatalog.pick>) =>
  contribCatalog.pick(...utilsEffectPeerDeps, ...additionalDeps)

export const getUtilsPeerDeps = () => contribCatalog.peers(...utilsEffectPeerDeps)

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

const prepareLivestoreContribCiScriptsStep = {
  name: 'Prepare CI helper scripts',
  shell: 'bash',
  run: [
    'set -euo pipefail',
    "scripts_src='repos/livestore/genie/ci-scripts'",
    `scripts_dst='${preparedCiRuntimeScriptsDir}'`,
    'if [ ! -d "$scripts_src" ]; then',
    '  echo "::error::CI helper script directory is missing after megarepo sync: $scripts_src"',
    '  exit 1',
    'fi',
    'rm -rf "$scripts_dst"',
    'mkdir -p "$scripts_dst"',
    'cp -R "$scripts_src/." "$scripts_dst/"',
    'rm -f "$scripts_dst"/*.genie.ts',
    'chmod +x "$scripts_dst"/*.sh',
  ].join('\n'),
} as const

export const livestoreContribSetupStepsAfterCheckout = [
  installNixStep({
    extraConf:
      'extra-substituters = https://cache.nixos.org\nextra-trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
  }),
  applyMegarepoLockStep(),
  prepareLivestoreContribCiScriptsStep,
  preparePinnedDevenvStep,
  pnpmStateSetupStep,
  restorePnpmStateStep({ keyPrefix: 'livestore-contrib-pnpm-state-v1' }),
  validateNixStoreStep,
] as const

export const livestoreContribSetupSteps = [checkoutStep(), ...livestoreContribSetupStepsAfterCheckout] as const
