/**
 * Contrib repository composition helpers.
 *
 * Core and effect-utils remain the source of truth for shared generator
 * helpers. Contrib imports core helpers through the materialized repo symlink.
 * Package-local helpers below intentionally override the core exports with
 * contrib repository identity, so imported package manifests can keep using
 * `../../../genie/repo.ts`.
 */

/** CI setup atoms must come from contrib's pinned effect-utils member as one coherent version. */
import {
  checkoutStep,
  defaultRefPolicyCheckJob,
  installNixStep,
  namespaceRunner as namespaceRunnerBase,
  pnpmStateSetupStep,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  restorePnpmStateStep,
  validateNixStoreStep,
} from '../repos/effect-utils/genie/ci-workflow.ts'
import { jsonArtifact } from '../repos/effect-utils/packages/@overeng/genie/src/runtime/json-artifact/mod.ts'
import {
  applyMegarepoLockStep as coreApplyMegarepoLockStep,
  baseTsconfigCompilerOptions as coreBaseTsconfigCompilerOptions,
  livestorePackageDefaults as coreLivestorePackageDefaults,
  type PnpmPackageClosureConfig,
  utilsEffectPeerDeps,
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

/**
 * Override core's `effectDevDeps` so contrib-owned packages resolve Effect
 * dev dependencies against contrib's catalog (`4.0.0-beta.98`) instead of core's
 * (`4.0.0-beta.97`). This explicit named export shadows the `export *` re-export
 * from core's repo helpers. `getUtilsPeerDeps` intentionally stays on core's
 * `^4.0.0-beta.97` peer ranges (which beta.98 satisfies).
 */
export const effectDevDeps = (...additionalDeps: Parameters<typeof contribCatalog.pick>) =>
  contribCatalog.pick(...utilsEffectPeerDeps, ...additionalDeps)

/**
 * Keep Effect warnings and errors gating while the existing suggestion backlog
 * remains advisory. This is the repository-local transition override supported
 * by the shared Effect diagnostics policy.
 */
export const baseTsconfigCompilerOptions = {
  ...coreBaseTsconfigCompilerOptions,
  plugins: coreBaseTsconfigCompilerOptions.plugins.map((plugin) => ({
    ...plugin,
    ignoreEffectSuggestionsInTscExitCode: true,
  })),
}

export const githubRepositorySettings = <const TSettings extends Record<string, unknown>>(settings: TSettings) =>
  jsonArtifact({ data: settings })

export const namespaceRunner = (runId: string) =>
  namespaceRunnerBase({ profile: 'namespace-profile-linux-x86-64', runId })

/** Source policy must use the same pinned effect-utils implementation as every other CI atom. */
export const livestoreDefaultRefPolicyJob = defaultRefPolicyCheckJob({
  runsOn: namespaceRunner('${{ github.run_id }}'),
  firstPartyOwners: ['overengineeringstudio'],
  normalizeGitBranchRefs: true,
  verifyReachable: true,
})

/**
 * Core's shared CI step resolves the megarepo CLI from the locked effect-utils
 * commit, but its default tracking worktree can still advance a branch-backed
 * member past that lock. Contrib CI is a lock materialization boundary.
 */
export const applyMegarepoLockStep = (opts?: Parameters<typeof coreApplyMegarepoLockStep>[0]) => {
  const step = coreApplyMegarepoLockStep(opts)
  return {
    ...step,
    run: `${step.run} --worktree-mode commit --lock-sync off`,
  }
}

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
  /**
   * Must precede any retry-wrapped command: the helpers are copied out of the
   * checkout into `runner.temp`, so a later alternate checkout cannot replace
   * them mid-job. Genie enforces the ordering.
   */
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
